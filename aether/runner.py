"""The queue worker. Runs jobs through an agent extension (stdin/stdout JSON lines, spec/v0.1.md §4), one task per session:
the first waiting job of every session that has nothing running starts at once, each in its own agent process and thread
(a session is a task's ref up to "#", or the task alone). The next job of a busy session waits for it. No limit on how many sessions run."""

from __future__ import annotations

import base64
import json
import os
import re
import select
import signal
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


def command(agent: dict) -> list:
    return [a.replace("{dir}", agent["dir"]).replace("{python}", sys.executable) for a in agent["command"]]


class Runner:
    def __init__(self, store, agents, workspace: Path, protect, logs: Path):
        self.store, self.agents, self.ws, self.protect, self.logs = store, agents, workspace, [str(p) for p in protect], logs
        self.env = dict   # () -> extra env for agent processes (settings.json vertex / env); the core sets it
        self.wake = threading.Event()
        self.starting = set()   # jobs handed to a thread, until that thread ends
        self.launching = set()   # jobs between the pick and their agent process being live (a swap waits for these)
        self.hold = False   # no new job starts (--reload, for the moment of a swap); queued ones stay queued
        self.handing = False   # a swap is taking the live jobs over: readers stop where they are
        self.live = {}   # job id -> handle (see _handle)
        self.stopping = set()

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
            self.store.set_job(job["id"], state="failed", error=repr(e)[:500], ended=time.time())
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
        start = {"type": "start", "aether": PROTOCOL, "prompt": job["prompt"], "session": self.store.session(job["task"], a["id"]),
                 "cwd": str(self.ws), "protect": self.protect}
        self.logs.mkdir(parents=True, exist_ok=True)
        with open(self.logs / f"{jid}.err", "w") as err:   # the agent writes its stderr there itself (it outlives a swap)
            p = subprocess.Popen(command(a), cwd=str(self.ws), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                 bufsize=0, start_new_session=True, env={**os.environ, **self.env()})
        h = self.live[jid] = self._handle(p.pid, p.stdin, p.stdout.fileno(), p.wait, bool(a.get("inject")), job["task"], a["id"])
        h["keep"] = p   # the stdout pipe lives as long as the Popen
        self.launching.discard(jid)
        self._write(h, start)
        if jid in self.stopping:
            self._kill(h["pid"])
        self.follow(jid, h)

    def follow(self, jid: str, h: dict):
        """Read the agent's JSON lines until it ends, then settle the job. Reads only while holding rlock, so a swap that holds every
        rlock knows no line is half handled; it then hands over `buf` (the bytes read but not yet a whole line)."""
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
        code = h["wait"]()
        with h["lock"]:
            h["open"] = False
            self._close_in(h)
        self.live.pop(jid, None)
        try:
            os.close(h["out"]) if "keep" not in h else h["keep"].stdout.close()
        except OSError:
            pass
        if jid in self.stopping:
            self.stopping.discard(jid)
            self.store.set_job(jid, state="stopped", ended=time.time())
            return
        done, error = h["done"], h["error"]
        if done and not error:
            cost = done.get("cost")
            self.store.set_job(jid, state="done", reply=str(done.get("reply") or ""), ended=time.time(),
                               cost=float(cost) if isinstance(cost, (int, float)) else None)
        else:
            tail = (self.logs / f"{jid}.err").read_text(errors="replace")[-300:] if (self.logs / f"{jid}.err").is_file() else ""
            self.store.set_job(jid, state="failed", error=error or tail or f"the agent exited ({code}) without done", ended=time.time())

    def _event(self, jid: str, h: dict, raw: bytes):
        try:
            ev = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            return
        if not isinstance(ev, dict):
            return
        if ev.get("step"):
            self.store.add_line(jid, str(ev["step"])[:300], str(ev["full"]) if ev.get("full") else None)   # full: the step's whole text (optional)
        if ev.get("session"):
            self.store.set_session(h["task"], h["agent"], str(ev["session"]))
        if ev.get("error"):
            h["error"] = str(ev["error"])[:500]
        if ev.get("done"):
            h["done"] = ev
            with h["lock"]:   # the agent has answered: no more injects
                h["open"] = False
                self._close_in(h)

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
                        "stopping": jid in self.stopping})
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
