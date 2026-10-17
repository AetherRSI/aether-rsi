"""SQLite store: tasks, jobs (the queue) and agent sessions. `rev` grows on every change so the UI polls one number."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

SCHEMA = """
create table if not exists tasks (id text primary key, title text not null, status text not null default 'doing', ts real not null);
create table if not exists jobs (id text primary key, task text not null, text text not null, prompt text not null, agent text not null,
  state text not null default 'queued', lines text not null default '[]', reply text not null default '', error text not null default '',
  cost real, ts real not null, started real, ended real);
create table if not exists sessions (task text not null, agent text not null, sid text not null, primary key (task, agent));
create table if not exists meta (k text primary key, v integer not null);
"""
STATUSES = ("doing", "done")
JOB_STATES = ("queued", "running", "done", "failed", "stopped")


def _id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, path):
        self.path = str(path)
        self.lock = threading.Lock()
        with self._db() as c:
            c.executescript(SCHEMA)
            c.execute("insert or ignore into meta (k, v) values ('rev', 0)")

    @contextmanager
    def _db(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        try:
            with c:   # commit or roll back
                yield c
        finally:
            c.close()

    def _bump(self, c):
        c.execute("update meta set v = v + 1 where k = 'rev'")

    def rev(self) -> int:
        with self._db() as c:
            return c.execute("select v from meta where k = 'rev'").fetchone()[0]

    # ---- tasks ----
    def tasks(self, status: str = "doing") -> list:
        with self._db() as c:
            return [dict(r) for r in c.execute("select * from tasks where status = ? order by ts", (status,))]

    def task(self, tid: str):
        with self._db() as c:
            r = c.execute("select * from tasks where id = ?", (tid or "",)).fetchone()
            return dict(r) if r else None

    def add_task(self, title: str) -> dict:
        t = {"id": _id(), "title": title.strip()[:80] or "Untitled", "status": "doing", "ts": time.time()}
        with self._db() as c:
            c.execute("insert into tasks (id, title, status, ts) values (:id, :title, :status, :ts)", t)
            self._bump(c)
        return t

    def update_task(self, tid: str, title: str = None, status: str = None) -> dict:
        if status is not None and status not in STATUSES:
            raise ValueError(f"status must be one of {STATUSES}")
        with self._db() as c:
            if title is not None:
                c.execute("update tasks set title = ? where id = ?", (title.strip()[:80] or "Untitled", tid))
            if status is not None:
                c.execute("update tasks set status = ? where id = ?", (status, tid))
            self._bump(c)
        return self.task(tid)

    # ---- jobs ----
    def add_job(self, task: str, text: str, prompt: str, agent: str, first: bool = False) -> dict:
        """first: run next (used when an inject arrives after the job ended)."""
        ts = time.time()
        if first:
            with self._db() as c:
                low = c.execute("select min(ts) from jobs where state = 'queued'").fetchone()[0]
            ts = low - 0.001 if low is not None else ts
        j = {"id": _id(), "task": task, "text": text, "prompt": prompt, "agent": agent, "ts": ts}
        with self._db() as c:
            c.execute("insert into jobs (id, task, text, prompt, agent, ts) values (:id, :task, :text, :prompt, :agent, :ts)", j)
            self._bump(c)
        return self.job(j["id"])

    def job(self, jid: str):
        with self._db() as c:
            r = c.execute("select * from jobs where id = ?", (jid,)).fetchone()
        return self._job(r) if r else None

    def _job(self, r) -> dict:
        j = dict(r)
        j["lines"] = json.loads(j["lines"])
        return j

    def jobs(self, task: str = None, n: int = 40) -> list:
        w, a = ("where task = ?", (task, n)) if task else ("", (n,))
        with self._db() as c:
            return [self._job(r) for r in c.execute(f"select * from jobs {w} order by ts desc limit ?", a)][::-1]

    def next_job(self):
        with self._db() as c:
            r = c.execute("select * from jobs where state = 'queued' order by ts limit 1").fetchone()
        return self._job(r) if r else None

    def queued_before(self, jid: str) -> int:
        j = self.job(jid)
        with self._db() as c:
            return c.execute("select count(*) from jobs where state = 'queued' and ts < ?", (j["ts"],)).fetchone()[0]

    def set_job(self, jid: str, **kw):
        if "state" in kw and kw["state"] not in JOB_STATES:
            raise ValueError(kw["state"])
        if "lines" in kw:
            kw["lines"] = json.dumps(kw["lines"], ensure_ascii=False)
        with self._db() as c:
            c.execute("update jobs set " + ", ".join(f"{k} = ?" for k in kw) + " where id = ?", (*kw.values(), jid))
            self._bump(c)

    def add_line(self, jid: str, line: str):
        with self.lock:
            j = self.job(jid)
            self.set_job(jid, lines=j["lines"] + [line])

    def recover(self):
        """Jobs left running by a dead server cannot be resumed."""
        with self._db() as c:
            c.execute("update jobs set state = 'failed', error = 'server restarted', ended = ? where state = 'running'", (time.time(),))
            self._bump(c)

    # ---- sessions (one conversation per task and agent) ----
    def session(self, task: str, agent: str):
        with self._db() as c:
            r = c.execute("select sid from sessions where task = ? and agent = ?", (task, agent)).fetchone()
            return r[0] if r else None

    def set_session(self, task: str, agent: str, sid: str):
        with self._db() as c:
            c.execute("insert or replace into sessions (task, agent, sid) values (?, ?, ?)", (task, agent, sid))
