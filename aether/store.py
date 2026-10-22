"""SQLite store: tasks (each may carry a ref to the app's session), jobs (the queue) and agent sessions. `rev` grows on every change so the UI polls one number."""

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
  state text not null default 'queued', lines text not null default '[]', fulls text not null default '{}', reply text not null default '', error text not null default '',
  cost real, ts real not null, started real, ended real);
create index if not exists jobs_task on jobs (task, state);
create table if not exists sessions (task text not null, agent text not null, sid text not null, primary key (task, agent));
create table if not exists meta (k text primary key, v integer not null);
"""
STATUSES = ("doing", "done")
JOB_STATES = ("queued", "running", "done", "failed", "stopped")
# One task at a time per session: a running job holds its session (a task's ref up to "#", or the task itself when it has no ref),
# so a different session's first task may run beside it, and the next one of the same session waits
FREE = ("not exists (select 1 from jobs r join tasks rt on rt.id = r.task where r.state = 'running'"
        " and sess(rt.ref, rt.id) = (select sess(jt.ref, jt.id) from tasks jt where jt.id = jobs.task))")


def session_of(ref: str, task: str) -> str:
    """The session a task belongs to: its ref up to "#" (e.g. "robosim-live/sessions/12"), else the task alone."""
    return (ref or "").split("#")[0].strip() or f"task:{task}"


class _Moved(Exception):
    """A job of the session started while the waiting ones were being reordered (the move is rolled back)."""


def _id() -> str:
    return uuid.uuid4().hex[:12]


def check_ref(ref) -> str:
    """A task's ref: where an app keeps it, e.g. "robosim-live/sessions/12#n7-3". The core never reads it; the shell bundles
    tasks by the part before "#" (the session). One line, up to 300 characters; "" = none."""
    if not isinstance(ref, str) or "\n" in ref or "\r" in ref or len(ref) > 300:
        raise ValueError("ref must be one line of up to 300 characters")
    return ref.strip()


class Store:
    def __init__(self, path):
        self.path = str(path)
        self.lock = threading.Lock()
        with self._db() as c:
            c.executescript(SCHEMA)
            if "ref" not in [r[1] for r in c.execute("pragma table_info(tasks)")]:   # a store made before ref existed
                c.execute("alter table tasks add column ref text not null default ''")
            if "fulls" not in [r[1] for r in c.execute("pragma table_info(jobs)")]:   # a store made before a step could carry its whole text
                c.execute("alter table jobs add column fulls text not null default '{}'")
            c.execute("insert or ignore into meta (k, v) values ('rev', 0)")

    @contextmanager
    def _db(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.create_function("sess", 2, session_of, deterministic=True)
        try:
            with c:   # commit or roll back
                yield c
        finally:
            c.close()

    def _bump(self, c):
        c.execute("update meta set v = v + 1 where k = 'rev'")

    def bump(self):
        """Something outside the tables changed (--reload holds the queue): the shell refetches."""
        with self._db() as c:
            self._bump(c)

    def rev(self) -> int:
        with self._db() as c:
            return c.execute("select v from meta where k = 'rev'").fetchone()[0]

    # ---- tasks ----
    def tasks(self, status: str = "doing") -> list:
        """status None: every task. Each carries the state and agent of its running job, else a waiting one, else its latest ('' when it has none),
        how many of its jobs wait in the queue, and when it last moved (last: a job's end, start or send, else the task's own time).
        "doing" also brings a task marked done while one of its jobs still waits or runs: it is in progress, whatever its mark says."""
        live = "exists (select 1 from jobs where task = t.id and state in ('queued', 'running'))"
        w, a = (f"where t.status = ?{f' or {live}' if status == 'doing' else ''}", (status,)) if status else ("", ())
        pick = "from jobs where task = t.id order by case state when 'running' then 0 when 'queued' then 1 else 2 end, ts desc limit 1"   # running beats queued beats the latest one (a priority send is stamped earlier than the last one)
        with self._db() as c:
            return [dict(r) for r in c.execute(f"select t.*, coalesce((select state {pick}), '') as job, coalesce((select agent {pick}), '') as agent,"
                                               " (select count(*) from jobs where task = t.id and state = 'queued') as queued,"
                                               " coalesce((select max(coalesce(ended, started, ts)) from jobs where task = t.id), t.ts) as last"   # the last time something happened in it (📋 Tasks › 🕘 Past sorts by it)
                                               f" from tasks t {w} order by ts", a)]

    def task(self, tid: str):
        with self._db() as c:
            r = c.execute("select * from tasks where id = ?", (tid or "",)).fetchone()
            return dict(r) if r else None

    def add_task(self, title: str, ref: str = "") -> dict:
        t = {"id": _id(), "title": title.strip()[:80] or "Untitled", "status": "doing", "ts": time.time(), "ref": check_ref(ref)}
        with self._db() as c:
            c.execute("insert into tasks (id, title, status, ts, ref) values (:id, :title, :status, :ts, :ref)", t)
            self._bump(c)
        return t

    def update_task(self, tid: str, title: str = None, status: str = None, ref: str = None) -> dict:
        if status is not None and status not in STATUSES:
            raise ValueError(f"status must be one of {STATUSES}")
        ref = None if ref is None else check_ref(ref)
        with self._db() as c:
            if title is not None:
                c.execute("update tasks set title = ? where id = ?", (title.strip()[:80] or "Untitled", tid))
            if status is not None:
                c.execute("update tasks set status = ? where id = ?", (status, tid))
            if ref is not None:
                c.execute("update tasks set ref = ? where id = ?", (ref, tid))
            self._bump(c)
        return self.task(tid)

    # ---- jobs ----
    def add_job(self, task: str, text: str, prompt: str, agent: str, first: bool = False) -> dict:
        """first: run next (priority send, or an inject that arrives after the job ended)."""
        ts = time.time()
        if first:
            with self._db() as c:
                low = c.execute("select min(ts) from jobs where state = 'queued'").fetchone()[0]
            ts = low - 0.001 if low is not None else ts
        j = {"id": _id(), "task": task, "text": text, "prompt": prompt, "agent": agent, "ts": ts}
        with self._db() as c:
            c.execute("insert into jobs (id, task, text, prompt, agent, ts) values (:id, :task, :text, :prompt, :agent, :ts)", j)
            c.execute("update tasks set status = 'doing' where id = ?", (task,))   # asking a done task for more reopens it
            self._bump(c)
        return self.job(j["id"])

    def job(self, jid: str):
        with self._db() as c:
            r = c.execute("select * from jobs where id = ?", (jid,)).fetchone()
        return self._job(r) if r else None

    def _job(self, r) -> dict:
        j = dict(r)
        j["lines"] = json.loads(j["lines"])
        j["fulls"] = json.loads(j.get("fulls") or "{}")   # {line index: the whole text} for steps the agent cut short
        return j

    def jobs(self, task: str = None, n: int = 40) -> list:
        """Each job carries its task's title (the shell shows it on the bubble when all tasks are listed)."""
        w, a = ("where j.task = ?", (task, n)) if task else ("", (n,))
        with self._db() as c:
            return [self._job(r) for r in c.execute(f"select j.*, coalesce(t.title, '') as title from jobs j left join tasks t on t.id = j.task"
                                                    f" {w} order by j.ts desc limit ?", a)][::-1]

    def queue(self) -> list:
        """What runs and what waits: the running jobs first, then the queued ones in the order they will run. pos is the place in its
        own session (1 = next when the session's running task ends). Each carries its task's title and ref (the shell bundles by
        session), the first line of what was sent (text), all of it up to 2,000 characters (full) and its prompt (the server turns it into quotes)."""
        with self._db() as c:
            rows = c.execute("select j.id, j.task, j.text, j.prompt, j.agent, j.state, j.ts, j.started, coalesce(t.title, '') as title, coalesce(t.ref, '') as ref"
                             " from jobs j left join tasks t on t.id = j.task where j.state in ('running', 'queued')"
                             " order by j.state = 'queued', coalesce(j.started, j.ts), j.ts").fetchall()
        out, pos = [], {}
        for r in rows:
            d = dict(r)
            d["full"] = (d["text"] or "").strip()[:2000]   # the whole of what was sent: the row's tooltip (2026-10-18 「タスクオンマウスで…を表示」)
            d["text"] = d["full"].splitlines()[0][:120] if d["full"] else ""
            if d["state"] == "queued":
                k = session_of(d["ref"], d["task"])
                pos[k] = d["pos"] = pos.get(k, 0) + 1
            out.append(d)
        return out

    def edit_job(self, jid: str, text: str, prompt: str, was: tuple) -> bool:
        """Rewrite a job that still waits. was: the (text, prompt) it was read with, so it fails (False) once the job started
        or another edit got there first ―― the caller reads it again."""
        with self._db() as c:
            n = c.execute("update jobs set text = ?, prompt = ? where id = ? and state = 'queued' and text = ? and prompt = ?",
                          (text, prompt, jid, *was)).rowcount
            if n:
                self._bump(c)
        return bool(n)

    def claim(self, jid: str):
        """queued → running in one step, then the job as it is now (None: it was stopped, had started, or its session is running another one)."""
        with self._db() as c:
            n = c.execute(f"update jobs set state = 'running', started = ? where id = ? and state = 'queued' and {FREE}", (time.time(), jid)).rowcount
            if n:
                self._bump(c)
        return self.job(jid) if n else None

    def ready(self) -> list:
        """The jobs that may start now: the first waiting one of every session that has nothing running, oldest first."""
        with self._db() as c:
            rows = c.execute(f"select jobs.*, sess(coalesce(t.ref, ''), jobs.task) as sess from jobs left join tasks t on t.id = jobs.task"
                             f" where state = 'queued' and {FREE} order by jobs.ts").fetchall()
        out, seen = [], set()
        for r in rows:
            if r["sess"] not in seen:
                seen.add(r["sess"])
                out.append(self._job(r))
        return out

    def running(self) -> list:
        """The running jobs with their task's title and ref (who is editing what, for a conflict check before a send)."""
        with self._db() as c:
            return [self._job(r) for r in c.execute("select j.*, coalesce(t.title, '') as title, coalesce(t.ref, '') as ref from jobs j"
                                                     " left join tasks t on t.id = j.task where j.state = 'running'")]

    def move_job(self, jid: str, task: str) -> bool:
        """⚡ A waiting job goes to another task (a session of its own). False when it no longer waits."""
        with self._db() as c:
            n = c.execute("update jobs set task = ? where id = ? and state = 'queued'", (task, jid)).rowcount
            if n:
                self._bump(c)
        return bool(n)

    def move_queued(self, jid: str, before: str = None) -> bool:
        """Drag a waiting job within its session: it goes just before `before` (another waiting job of the same session), or last when
        None. The session's waiting jobs swap their ts among themselves, so no other session's order moves. False when it no longer
        waits (it or one it is moved past started meanwhile: nothing changes); ValueError when `before` is not one of its session's waiting jobs."""
        try:
            return self._move_queued(jid, before)
        except _Moved:
            return False

    def _move_queued(self, jid, before):
        with self._db() as c:
            j = c.execute("select jobs.id, sess(coalesce(t.ref, ''), jobs.task) as sess from jobs left join tasks t on t.id = jobs.task"
                          " where jobs.id = ? and state = 'queued'", (jid,)).fetchone()
            if not j:
                return False
            rows = [r for r in c.execute("select jobs.id, jobs.ts, sess(coalesce(t.ref, ''), jobs.task) as sess from jobs left join tasks t"
                                         " on t.id = jobs.task where state = 'queued' order by jobs.ts") if r["sess"] == j["sess"]]
            ids, stamps = [r["id"] for r in rows], [r["ts"] for r in rows]
            if before is not None and (before == jid or before not in ids):
                raise ValueError("before must be another waiting job of the same session")
            ids.remove(jid)
            ids.insert(ids.index(before) if before else len(ids), jid)
            for i, ts in zip(ids, stamps):
                if not c.execute("update jobs set ts = ? where id = ? and state = 'queued'", (ts, i)).rowcount:
                    raise _Moved   # one of them started meanwhile: roll the whole move back
            self._bump(c)
        return True

    def queued_before(self, jid: str) -> int:
        """How many wait before it in its own session."""
        with self._db() as c:
            return c.execute("select count(*) from jobs q join tasks qt on qt.id = q.task, jobs j join tasks jt on jt.id = j.task"
                             " where j.id = ? and q.state = 'queued' and q.ts < j.ts and sess(qt.ref, qt.id) = sess(jt.ref, jt.id)", (jid,)).fetchone()[0]

    def set_job(self, jid: str, **kw):
        if "state" in kw and kw["state"] not in JOB_STATES:
            raise ValueError(kw["state"])
        for k in ("lines", "fulls"):
            if k in kw:
                kw[k] = json.dumps(kw[k], ensure_ascii=False)
        with self._db() as c:
            c.execute("update jobs set " + ", ".join(f"{k} = ?" for k in kw) + " where id = ?", (*kw.values(), jid))
            self._bump(c)

    def add_line(self, jid: str, line: str, full: str = None):
        """full: the whole text of a step the agent cut short (kept beside the line; the shell opens it with …)"""
        with self.lock:
            j = self.job(jid)
            kw = {"lines": j["lines"] + [line]}
            if full and full.strip() != line.strip():
                kw["fulls"] = {**j["fulls"], str(len(j["lines"])): full[:20000]}
            self.set_job(jid, **kw)

    def recover(self, keep=()):
        """Jobs left running by a dead server cannot be resumed (keep: the ones a --reload swap handed over, still running)."""
        keep = list(keep)
        with self._db() as c:
            c.execute(f"update jobs set state = 'failed', error = 'server restarted', ended = ? where state = 'running'"
                      f" and id not in ({','.join('?' * len(keep)) or "''"})", (time.time(), *keep))
            self._bump(c)

    # ---- sessions (one conversation per task and agent) ----
    def session(self, task: str, agent: str):
        with self._db() as c:
            r = c.execute("select sid from sessions where task = ? and agent = ?", (task, agent)).fetchone()
            return r[0] if r else None

    def set_session(self, task: str, agent: str, sid: str):
        with self._db() as c:
            c.execute("insert or replace into sessions (task, agent, sid) values (?, ?, ?)", (task, agent, sid))
