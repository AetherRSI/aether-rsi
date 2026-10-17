"""The queue worker. Runs one job at a time through an agent extension (stdin/stdout JSON lines, spec/v0.1.md §4)."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import PROTOCOL


def compose(text: str, quotes) -> str:
    """The prompt the agent sees: the message, then each quote under its @n."""
    parts = [text.strip()]
    for q in quotes or []:
        head = f"@{q.get('n') or '-'} {q.get('label') or ''}".rstrip()
        if q.get("rules"):
            head += f" (an app folder: read {q['rules']} first and follow it)"
        body = str(q.get("text") or "").strip()
        parts.append(head + ("\n" + "\n".join("> " + x for x in body.splitlines()) if body else ""))
    return parts[0] if len(parts) == 1 else parts[0] + "\n\n---\nQuoted:\n" + "\n\n".join(parts[1:])


def command(agent: dict) -> list:
    return [a.replace("{dir}", agent["dir"]).replace("{python}", sys.executable) for a in agent["command"]]


class Runner:
    def __init__(self, store, agents, workspace: Path, protect, logs: Path):
        self.store, self.agents, self.ws, self.protect, self.logs = store, agents, workspace, [str(p) for p in protect], logs
        self.wake = threading.Event()
        self.live = {}   # job id -> {"p": Popen, "lock": Lock, "open": bool}
        self.stopping = set()

    def start(self):
        self.store.recover()
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            job = self.store.next_job()
            if not job:
                self.wake.wait(1)
                self.wake.clear()
                continue
            try:
                self.run(job)
            except Exception as e:  # noqa: BLE001 ―― one broken job must not stop the queue
                self.store.set_job(job["id"], state="failed", error=repr(e)[:500], ended=time.time())

    def run(self, job: dict):
        jid, a = job["id"], self.agents().get(job["agent"])
        if not a or a.get("disabled"):
            self.store.set_job(jid, state="failed", error=a["disabled"] if a else f"no agent {job['agent']!r}", ended=time.time())
            return
        self.store.set_job(jid, state="running", started=time.time())
        start = {"type": "start", "aether": PROTOCOL, "prompt": job["prompt"], "session": self.store.session(job["task"], a["id"]),
                 "cwd": str(self.ws), "protect": self.protect}
        self.logs.mkdir(parents=True, exist_ok=True)
        done, error = None, ""
        with open(self.logs / f"{jid}.err", "w") as err:
            p = subprocess.Popen(command(a), cwd=str(self.ws), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                 text=True, bufsize=1, start_new_session=True)
            h = self.live[jid] = {"p": p, "lock": threading.Lock(), "open": True, "inject": bool(a.get("inject"))}
            self._write(h, start)
            if jid in self.stopping:
                self._kill(p)
            for raw in p.stdout:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if ev.get("step"):
                    self.store.add_line(jid, str(ev["step"])[:300])
                if ev.get("session"):
                    self.store.set_session(job["task"], a["id"], str(ev["session"]))
                if ev.get("error"):
                    error = str(ev["error"])[:500]
                if ev.get("done"):
                    done = ev
                    with h["lock"]:   # the agent has answered: no more injects
                        h["open"] = False
                        try:
                            p.stdin.close()
                        except OSError:
                            pass
            p.wait()
            p.stdout.close()
            with h["lock"]:
                h["open"] = False
                if not p.stdin.closed:
                    try:
                        p.stdin.close()
                    except OSError:
                        pass
            self.live.pop(jid, None)
        if jid in self.stopping:
            self.stopping.discard(jid)
            self.store.set_job(jid, state="stopped", ended=time.time())
            return
        if done and not error:
            cost = done.get("cost")
            self.store.set_job(jid, state="done", reply=str(done.get("reply") or ""), ended=time.time(),
                               cost=float(cost) if isinstance(cost, (int, float)) else None)
        else:
            tail = (self.logs / f"{jid}.err").read_text(errors="replace")[-300:]
            self.store.set_job(jid, state="failed", error=error or tail or f"the agent exited ({p.returncode}) without done", ended=time.time())

    def _write(self, h, msg: dict) -> bool:
        with h["lock"]:
            if not h["open"]:
                return False
            try:
                h["p"].stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
                h["p"].stdin.flush()
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
                self._kill(h["p"])
        return self.store.job(jid)["state"]

    @staticmethod
    def _kill(p):
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
