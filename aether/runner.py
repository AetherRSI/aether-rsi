"""The queue worker. Runs jobs through an agent extension (stdin/stdout JSON lines, spec/v0.1.md §4), one task per session:
the first waiting job of every session that has nothing running starts at once, each in its own agent process and thread
(a session is a task's ref up to "#", or the task alone). The next job of a busy session waits for it. No limit on how many sessions run."""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import select
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import PROTOCOL


QUOTED = "\n\n---\nQuoted:\n"
AT = re.compile(r"(^|[^A-Za-z0-9_@])@(\d+)(?!\d)")   # @n in a message (as the shell reads it: a letter of any other script may touch it)


def _block(q: dict) -> str:
    head = f"@{q.get('n') or '-'} {q.get('label') or ''}".rstrip()
    if q.get("rules"):
        head += f" (an app folder: read {q['rules']} first and follow it)"
    body = str(q.get("text") or "").strip()
    return head + ("\n" + "\n".join("> " + x for x in body.splitlines()) if body else "")


def compose(text: str, quotes) -> str:
    """The prompt the agent sees: the message, then each quote under its @n."""
    blocks = [_block(q) for q in quotes or []]
    return text.strip() + (QUOTED + "\n\n".join(blocks) if blocks else "")


RULES = "AGENTS.md"   # the workspace's rules for every agent, whatever file its own tool reads (2026-10-25 "Gemini も使うので汎用の名前に")


def told(prompt: str, ws, session) -> str:
    """The prompt as sent: the first turn of a conversation in a workspace with AGENTS.md is told to read it, at the end so the message
    still leads (a /command stays one). The stored prompt stays as it was."""
    return f"{prompt}\n\n(This workspace has rules: read {RULES} first and follow it.)" if not session and ws and (Path(ws) / RULES).is_file() else prompt


def _blocks(prompt: str) -> list:
    i = prompt.find(QUOTED)
    return re.split(r"\n\n(?=@)", prompt[i + len(QUOTED):]) if i >= 0 else []   # a quote's own blank lines are "> ", so a blank line is between blocks


def quotes_of(prompt: str) -> list:
    """The quotes of a composed prompt, without their text: [{n, label}] (n 0 for "@-")."""
    out = []
    for b in _blocks(prompt):
        m = re.match(r"@(\d+|-) (.*)", b.split("\n", 1)[0])
        if m:
            out.append({"n": int(m.group(1)) if m.group(1).isdigit() else 0, "label": re.sub(r" \(an app folder: read .* first and follow it\)$", "", m.group(2))})
    return out


def append(old_text: str, old_prompt: str, text: str, quotes) -> tuple:
    """(text, prompt) of a waiting message with more added: the new quotes are numbered after its own, and @n in the new text follows them."""
    old = _blocks(old_prompt)
    top = max([int(m.group(1)) for m in (re.match(r"@(\d+) ", b) for b in old) if m] or [0])
    quotes = [q for q in quotes or [] if isinstance(q, dict)]
    shift = {q["n"]: q["n"] + top for q in quotes if isinstance(q.get("n"), int) and q["n"] > 0}
    text = AT.sub(lambda m: f"{m.group(1)}@{shift.get(int(m.group(2)), m.group(2))}", text.strip())
    new_text = old_text.rstrip() + "\n\n" + text
    blocks = old + [_block({**q, "n": shift[q["n"]]} if q.get("n") in shift else q) for q in quotes]
    return new_text, new_text + (QUOTED + "\n\n".join(blocks) if blocks else "")


def again(write, *a, tries: int = 5, **kw):
    """A store write that has to land (a job's last state): a locked store is asked again rather than leaving a running row with no
    process behind it, or a failed one whose agent runs on (2026-10-23)."""
    for i in range(tries):
        try:
            return write(*a, **kw)
        except sqlite3.OperationalError:
            if i == tries - 1:
                raise
            time.sleep(1 + i)


def command(agent: dict) -> list:
    return [a.replace("{dir}", agent["dir"]).replace("{python}", sys.executable) for a in agent["command"]]


class Runner:
    def __init__(self, store, agents, workspace: Path, protect, logs: Path):
        self.store, self.agents, self.ws, self.protect, self.logs = store, agents, workspace, [str(p) for p in protect], logs
        self.env = dict   # () -> extra env for agent processes (settings.json vertex / env); the core sets it
        self.after = lambda jid: None   # a job settled (whatever its end): the core draws the files it quoted ahead (render.py)
        self.wake = threading.Event()
        self.starting = set()   # jobs handed to a thread, until that thread ends
        self.launching = set()   # jobs between the pick and their agent process being live (a swap waits for these)
        self.hold = False   # no new job starts (--reload, for the moment of a swap); queued ones stay queued
        self.handing = False   # a swap is taking the live jobs over: readers stop where they are
        self.live = {}   # job id -> handle (see _handle)
        self.stopping = set()
        self.voiced = set()   # jobs sent from 🎙: their start says "audio": true (spec §4.2). In memory: a swap while one still waits forgets it
        self.voice_out = lambda jid, ev: None   # what an agent says for the shell's ears (voice.Voice.out); the core sets it
        self.voice_end = lambda jid, state: None   # a job settled: its mic hears the end (voice.Voice.ended)
        self.voice_ui = lambda jid, req: False   # an agent asks the shell's screen (spec §4.4): True when a mic took it (voice.Voice.ui)
        self.api = ""   # the core's base URL, for agents with dispatch: true (spec §4.3); the core sets it
        self.tokens = {}   # AETHER_TOKEN -> the job it was made for (while that job runs; a swap hands them over)
        self.sends = {}   # job id -> how many messages it dispatched

    def start(self, handoff=None):
        """handoff: the jobs a swap handed over (they keep running; see handoff()), by default from AETHER_HANDOFF.
        Others left running by a dead server failed."""
        if handoff is None:
            handoff = json.loads(os.environ.pop("AETHER_HANDOFF", "") or "[]")
        kept = [self.adopt(h) for h in handoff or []]
        self.store.recover(keep=kept)
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                ready = self.store.ready() if self.ws and not self.hold else []   # no workspace yet: queued jobs wait for one
            except Exception as e:  # noqa: BLE001 ―― a locked store must not end the loop: nothing queued would ever start again
                print(f"[queue] could not read the queue, trying again: {e!r}", file=sys.stderr, flush=True)
                ready = []
            for job in ready:
                if job["id"] not in self.starting:
                    self.starting.add(job["id"])
                    self.launching.add(job["id"])
                    threading.Thread(target=self.safe_run, args=(job,), daemon=True).start()
            self.wake.wait(0.5)   # a send wakes it; the timeout notices a session that a finished job freed
            self.wake.clear()

    def safe_run(self, job: dict, go=None):
        try:
            (go or self.run)(job)
        except Exception as e:  # noqa: BLE001 ―― one broken job must not stop the queue
            h = self.live.pop(job["id"], None)
            if h:   # its agent is up but nobody reads it any more: stop it rather than let it run on unseen
                self._kill(h["pid"])
            again(self.store.set_job, job["id"], state="failed", error=repr(e)[:500], ended=time.time())
        finally:
            self.launching.discard(job["id"])
            if not self.handing:   # handed over: the next process owns it now
                self.starting.discard(job["id"])
                self.wake.set()   # its session is free: the next one of it may start

    @staticmethod
    def _handle(pid, stdin, out_fd, wait, inject, task, agent, buf=b"", done=None, error="", open_=True) -> dict:
        """What the core holds of a live agent: its pid (also its process group), stdin (binary), the stdout fd it reads with its own
        buffer (so a swap can hand over the unread bytes exactly), how to wait for it, and what it said so far."""
        return {"pid": pid, "in": stdin, "out": out_fd, "wait": wait, "inject": inject, "task": task, "agent": agent, "buf": buf,
                "done": done, "error": error, "open": open_ and stdin is not None, "lock": threading.Lock(), "rlock": threading.Lock()}

    def run(self, job: dict):
        jid, a = job["id"], self.agents().get(job["agent"])
        if not a or a.get("disabled"):
            self.store.set_job(jid, state="failed", error=a["disabled"] if a else f"no agent {job['agent']!r}", ended=time.time())
            return
        job = self.store.claim(jid)   # an edit may have changed it since it was picked; a stop may have taken it
        if not job:
            return
        session = self.store.session(job["task"], a["id"])
        start = {"type": "start", "aether": PROTOCOL, "prompt": told(job["prompt"], self.ws, session), "session": session,
                 "cwd": str(self.ws), "protect": self.protect}
        if a.get("audio") and jid in self.voiced:
            start["audio"] = True
        self.voiced.discard(jid)
        self.logs.mkdir(parents=True, exist_ok=True)
        extra, tok = ({"AETHER_URL": self.api.rstrip("/")} if self.api else {}), None   # the core's URL: a folder's scripts reach the core here, whatever port it runs on
        if a.get("dispatch") and self.api:   # spec §4.3: the core's API, with a key good for this job only
            tok = secrets.token_urlsafe(24)
            self.tokens[tok] = jid
            extra |= {"AETHER_API": self.api, "AETHER_TOKEN": tok}
        with open(self.logs / f"{jid}.err", "w") as err:   # the agent writes its stderr there itself (it outlives a swap)
            p = subprocess.Popen(command(a), cwd=str(self.ws), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                 bufsize=0, start_new_session=True, env={**os.environ, **self.env(), **extra})
        h = self.live[jid] = self._handle(p.pid, p.stdin, p.stdout.fileno(), p.wait, bool(a.get("inject")), job["task"], a["id"])
        h["keep"] = p   # the stdout pipe lives as long as the Popen
        h["token"] = tok
        self.launching.discard(jid)
        self._write(h, start)
        if jid in self.stopping:
            self._kill(h["pid"])
        self.follow(jid, h)

    def follow(self, jid: str, h: dict):
        """Read the agent's JSON lines until it ends, then settle the job. Should the reading break, the agent is stopped and the job
        settles as failed: a job the core gave up on must not leave its agent running (2026-10-23)."""
        try:
            self._read(jid, h)
        except Exception as e:  # noqa: BLE001
            h["error"] = h["error"] or f"the core stopped reading the agent: {e!r}"[:500]
            self._kill(h["pid"])
        self._settle(jid, h)

    def _read(self, jid: str, h: dict):
        """Reads only while holding rlock, so a swap that holds every rlock knows no line is half handled; it then hands over `buf`
        (the bytes read but not yet a whole line)."""
        while True:
            if self.handing:   # a swap is taking it over: the next process reads on from here (or, if the swap fails, this one)
                time.sleep(0.05)
                continue
            with h["rlock"]:
                if self.handing:
                    continue
                if not select.select([h["out"]], [], [], 0.2)[0]:
                    continue
                chunk = os.read(h["out"], 65536)
                if not chunk:
                    break
                h["buf"] += chunk
                *lines, h["buf"] = h["buf"].split(b"\n")
                for raw in lines:
                    self._event(jid, h, raw)

    def _settle(self, jid: str, h: dict):
        try:
            self._settle_job(jid, h)
        finally:
            try:
                j = self.store.job(jid)
                self.voice_end(jid, j["state"] if j else "gone")
            except Exception as e:  # noqa: BLE001
                print(f"[voice] could not tell the mic the job ended: {e!r}", file=sys.stderr, flush=True)
            try:
                self.after(jid)
            except Exception as e:  # noqa: BLE001 ―― drawing ahead is a courtesy: it must not touch the job
                print(f"[render] could not draw ahead for {jid}: {e!r}", file=sys.stderr, flush=True)

    def _settle_job(self, jid: str, h: dict):
        code = h["wait"]()
        with h["lock"]:
            h["open"] = False
            self._close_in(h)
        self.live.pop(jid, None)
        if h.get("token"):
            self.tokens.pop(h["token"], None)
        self.sends.pop(jid, None)
        try:
            os.close(h["out"]) if "keep" not in h else h["keep"].stdout.close()
        except OSError:
            pass
        if jid in self.stopping:
            self.stopping.discard(jid)
            again(self.store.set_job, jid, state="stopped", ended=time.time())
            return
        done, error = h["done"], h["error"]
        if done and not error:
            cost = done.get("cost")
            again(self.store.set_job, jid, state="done", reply=str(done.get("reply") or ""), error="", ended=time.time(),
                  cost=float(cost) if isinstance(cost, (int, float)) else None)
        else:
            tail = (self.logs / f"{jid}.err").read_text(errors="replace")[-300:] if (self.logs / f"{jid}.err").is_file() else ""
            again(self.store.set_job, jid, state="failed", error=error or tail or f"the agent exited ({code}) without done", ended=time.time())

    def _event(self, jid: str, h: dict, raw: bytes):
        try:
            ev = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            return
        if not isinstance(ev, dict):
            return
        if ev.get("step"):
            self._note(self.store.add_line, jid, str(ev["step"])[:300], str(ev["full"]) if ev.get("full") else None)   # full: the step's whole text (optional)
        if ev.get("session"):
            self._note(self.store.set_session, h["task"], h["agent"], str(ev["session"]))
        if ev.get("audio") or ev.get("heard") or ev.get("said") or ev.get("interrupted"):   # 🎙 spec §4.2: the words are kept, the sound only played
            for k, mark in (("heard", "🎙 "), ("said", "🔊 ")):
                if ev.get(k):
                    t = str(ev[k]).strip()
                    self._note(self.store.add_line, jid, (mark + t)[:300], mark + t if len(t) > 290 else None)
            try:
                self.voice_out(jid, ev)
            except Exception as e:  # noqa: BLE001 ―― a broken ear must not stop the reading
                print(f"[voice] could not pass on to the shell: {e!r}", file=sys.stderr, flush=True)
        if isinstance(ev.get("ui"), dict):   # 🖱 spec §4.4: the shell's screen, through the mic's socket
            try:
                sent = self.voice_ui(jid, ev["ui"])
            except Exception as e:  # noqa: BLE001
                sent = False
                print(f"[voice] could not ask the screen: {e!r}", file=sys.stderr, flush=True)
            if not sent:
                self._write(h, {"type": "ui", "id": ev["ui"].get("id"), "error": "no screen: the mic is not open"})
        if ev.get("error"):
            h["error"] = str(ev["error"])[:500]
        if ev.get("done"):
            h["done"] = ev
            with h["lock"]:   # the agent has answered: no more injects
                h["open"] = False
                self._close_in(h)

    @staticmethod
    def _note(write, *a):
        """A step line or the session id: one that cannot be written is skipped, the job goes on (it was the whole job, 2026-10-23)."""
        try:
            again(write, *a, tries=2)
        except sqlite3.Error as e:
            print(f"[job] could not write to the store, skipping it: {e!r}", file=sys.stderr, flush=True)

    @staticmethod
    def _close_in(h):
        if h["in"] is not None and not h["in"].closed:
            try:
                h["in"].close()
            except OSError:
                pass

    # ---- --reload: hand the live jobs to the process that replaces this one (execv keeps the pid, so the agents stay its children) ----
    def handoff(self, limit: float = 30) -> list:
        """Stop starting jobs, wait for the ones being launched, stop every reader between two reads, and describe each live job
        (pid, the pipe fds made inheritable, unread bytes, what it said so far). release() undoes it when the swap does not happen."""
        self.hold = True
        end = time.time() + limit
        while self.launching and time.time() < end:
            time.sleep(0.05)
        if self.launching:
            self.hold = False
            raise TimeoutError("a job is still being launched")
        self.handing = True
        held = []
        for jid, h in list(self.live.items()):
            h["rlock"].acquire()
            held.append(h)
        self._held = held
        out = []
        for jid, h in list(self.live.items()):
            fin = h["in"].fileno() if h["in"] is not None and not h["in"].closed else None
            for fd in (fin, h["out"]):
                if fd is not None:
                    os.set_inheritable(fd, True)
            out.append({"job": jid, "pid": h["pid"], "in": fin, "out": h["out"], "buf": base64.b64encode(h["buf"]).decode(), "inject": h["inject"],
                        "task": h["task"], "agent": h["agent"], "done": h["done"], "error": h["error"], "open": h["open"],
                        "stopping": jid in self.stopping, "token": h.get("token"), "sends": self.sends.get(jid, 0)})
        return out

    def release(self):
        self.handing = False
        for h in getattr(self, "_held", []):
            try:
                h["rlock"].release()
            except RuntimeError:
                pass
        self._held = []
        self.hold = False
        self.wake.set()

    def adopt(self, d: dict) -> str:
        """A job handed over by the process this one replaced: read on from where it stopped."""
        def wait(pid=d["pid"]):
            try:
                return os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
            except ChildProcessError:
                return None
        stdin = os.fdopen(d["in"], "wb", buffering=0) if d.get("in") is not None else None
        for fd in (d.get("in"), d["out"]):
            if fd is not None:
                os.set_inheritable(fd, False)
        h = self.live[d["job"]] = self._handle(d["pid"], stdin, d["out"], wait, d.get("inject", False), d["task"], d["agent"],
                                               base64.b64decode(d.get("buf") or ""), d.get("done"), d.get("error") or "", d.get("open", True))
        if d.get("stopping"):
            self.stopping.add(d["job"])
        if d.get("token"):
            h["token"] = d["token"]
            self.tokens[d["token"]] = d["job"]
            self.sends[d["job"]] = int(d.get("sends") or 0)
        self.starting.add(d["job"])
        threading.Thread(target=self.safe_run, args=({"id": d["job"]}, lambda _j: self.follow(d["job"], h)), daemon=True).start()
        return d["job"]

    def _write(self, h, msg: dict) -> bool:
        with h["lock"]:
            if not h["open"]:
                return False
            try:
                h["in"].write((json.dumps(msg, ensure_ascii=False) + "\n").encode())
                return True
            except (BrokenPipeError, OSError, ValueError):
                h["open"] = False
                return False

    def inject(self, jid: str, text: str) -> bool:
        """Into the running conversation. False when the job is not running or the agent cannot take it."""
        h = self.live.get(jid)
        if not h or not h["inject"] or not self._write(h, {"type": "inject", "text": text}):
            return False
        self.store.add_line(jid, "↪ " + text[:200])
        return True

    def hears(self, jid: str) -> bool:
        """The job runs, or waits, in an agent that takes the person's voice (manifest audio)."""
        j = self.store.job(jid)
        a = self.agents().get(j["agent"]) if j else None
        return bool(a and a.get("audio") and j["state"] in ("queued", "running"))

    def hear(self, jid: str, pcm: bytes) -> bool:
        """🎙 A chunk of the person's voice (PCM16 16 kHz) into the running agent. False when it cannot take it any more."""
        h = self.live.get(jid)
        return bool(h and pcm) and self._write(h, {"type": "audio", "data": base64.b64encode(pcm).decode()})

    def bearer(self, tok: str):
        """The running job an AETHER_TOKEN was made for, or None (spec §4.3)."""
        jid = self.tokens.get(tok or "")
        return jid if jid and jid in self.live else None

    def ui_result(self, jid: str, m: dict) -> bool:
        """🖱 The shell's answer to a screen request, into the agent that asked (spec §4.4)."""
        h = self.live.get(jid)
        ans = {"type": "ui", "id": m.get("id")}
        ans.update({"result": m["result"]} if "result" in m else {"error": str(m.get("error") or "no answer")})
        return bool(h) and self._write(h, ans)

    def mic_end(self, jid: str) -> bool:
        """The person closed the mic: the agent finishes the conversation (spec §4.2)."""
        h = self.live.get(jid)
        return bool(h) and self._write(h, {"type": "audio", "end": True})

    def stop(self, jid: str) -> str:
        j = self.store.job(jid)
        if not j:
            raise LookupError("no such job")
        if j["state"] == "queued":
            self.store.set_job(jid, state="stopped", ended=time.time())
        elif j["state"] == "running":
            self.stopping.add(jid)
            h = self.live.get(jid)
            if h:
                self._kill(h["pid"])
        return self.store.job(jid)["state"]

    @staticmethod
    def _kill(pid):
        """SIGTERM to the agent's process group, SIGKILL 5 s later if it is still there (the reader reaps it)."""
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return

        def hard():
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        t = threading.Timer(5, hard)
        t.daemon = True
        t.start()
