"""The core: path guard, prompt composition, and the HTTP API driven end to end through the echo agent."""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import NO_SAMPLES, REPO, SAMPLES, Live
from aether import files
from aether.runner import append, compose, quotes_of
from aether.server import bundle, lock_state


class Guard(unittest.TestCase):
    def setUp(self):
        self.ws = Path(tempfile.mkdtemp()).resolve()
        (self.ws / "a").mkdir()
        (self.ws / "a/b.txt").write_text("hi")
        os.symlink("/", self.ws / "root")

    def test_inside(self):
        self.assertEqual(files.read(self.ws, "a/b.txt"), "hi")
        self.assertEqual([i["name"] for i in files.listing(self.ws, "")["items"]], ["a"])   # the symlink out is not listed

    def test_outside(self):
        for p in ("..", "../x", "/etc/hosts", "a/../../x", "root/etc/hosts", "a\\b.txt"):
            with self.assertRaises(files.Outside, msg=p):
                files.resolve(self.ws, p)

    def test_deny(self):
        with self.assertRaises(files.Outside):
            files.read(self.ws, "a/b.txt", deny=[self.ws / "a"])


class Compose(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(compose(" hi ", []), "hi")

    def test_quotes(self):
        p = compose("Fix @1", [{"n": 1, "label": "📄 a.md", "text": "x\ny"}, {"n": 2, "label": "🧩 app/", "rules": "app/CLAUDE.md"}])
        self.assertIn("@1 📄 a.md\n> x\n> y", p)
        self.assertIn("read app/CLAUDE.md first", p)

    def test_quotes_of(self):
        p = compose("Fix @1", [{"n": 1, "label": "📄 a.md", "text": "x\n\ny"}, {"n": 2, "label": "🧩 app/", "rules": "app/CLAUDE.md"}])
        self.assertEqual(quotes_of(p), [{"n": 1, "label": "📄 a.md"}, {"n": 2, "label": "🧩 app/"}])
        self.assertEqual(quotes_of("no quotes"), [])

    def test_append_numbers_after_the_old_quotes(self):
        """Added to a waiting message: its quotes keep @1 @2, the new ones become @3…, and @n in the added text follows them."""
        old = compose("Fix @1 and @2", [{"n": 1, "label": "a", "text": "x"}, {"n": 2, "label": "b"}])
        text, prompt = append("Fix @1 and @2", old, "also @1 と@2", [{"n": 1, "label": "c", "text": "z"}])
        self.assertEqual(text, "Fix @1 and @2\n\nalso @3 と@2")   # @2 names nothing new: left as it was
        self.assertEqual([q["n"] for q in quotes_of(prompt)], [1, 2, 3])
        self.assertIn("@3 c\n> z", prompt)
        self.assertEqual(append("hi", "hi", "more", []), ("hi\n\nmore", "hi\n\nmore"))


class Bundle(unittest.TestCase):
    def test_inlines_only_local_files(self):
        d = Path(tempfile.mkdtemp()).resolve()
        (d / "a.js").write_text("x('</script>')")
        (d / "s.css").write_text("b{}")
        (d / "i.png").write_bytes(b"\x89PNG")
        html = '<script src="a.js"></script><link rel="stylesheet" href="s.css"><img alt="" src="i.png"><script src="https://cdn/x.js"></script><img src="nope.png">'
        out = bundle(html, lambda u: (d / u) if (d / u).is_file() else None)
        self.assertIn("<script>x('<\\/script>')</script>", out)
        self.assertIn("<style>b{}</style>", out)
        self.assertIn('src="data:image/png;base64,', out)
        self.assertIn('<script src="https://cdn/x.js"></script>', out)
        self.assertIn('<img src="nope.png">', out)


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.live = Live()

    @classmethod
    def tearDownClass(cls):
        cls.live.close()

    def test_info(self):
        code, i = self.live.json("api/info")
        self.assertEqual(code, 200)
        self.assertTrue(i["locked"])
        self.assertEqual(i["protocol"], "0.1")
        self.assertEqual({a["id"] for a in i["agents"]}, {"claude-code", "echo-agent", "gemini-argon"})
        self.assertEqual(i["errors"], [])

    def test_post_needs_header(self):
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, {"X-Aether": ""})[0], 403)
        self.assertEqual(self.live.call("api/tasks", {"title": "x"}, {"Origin": "null"})[0], 403)

    def test_send_makes_a_task_and_runs(self):
        code, r = self.live.json("api/send", {"text": "hello\nsecond line", "agent": "echo-agent", "quotes": [{"n": 1, "label": "q", "text": "t"}]})
        self.assertEqual(code, 200)
        self.assertEqual(r["task"]["title"], "hello")
        j = self.live.wait_job(r["job"], task=r["task"]["id"])
        self.assertEqual(j["state"], "done")
        self.assertTrue(j["reply"].startswith("Echo: hello"))
        self.assertIn("@1 q", j["reply"])
        code, r2 = self.live.json("api/send", {"text": "again", "agent": "echo-agent", "task": r["task"]["id"]})
        j2 = self.live.wait_job(r2["job"])
        self.assertIn("continuing", j2["lines"][0])   # same task → same session
        self.live.json(f"api/tasks/{r['task']['id']}", {"status": "done"})
        self.assertNotIn(r["task"]["id"], [t["id"] for t in self.live.json("api/tasks")[1]])
        t = next(x for x in self.live.json("api/tasks?all=1")[1] if x["id"] == r["task"]["id"])   # 🕘 Past: still there with all=1, sorted by when it last moved
        self.assertEqual(t["agent"], "echo-agent")
        self.assertGreaterEqual(t["last"], j2["ts"])
        self.assertGreater(t["last"], t["ts"])

    def test_running_task_stays_listed_and_more_reopens(self):
        """Marked done while its job runs: still in the list, as running. Asking a done task for more puts it back to doing."""
        _, r = self.live.json("api/send", {"text": "/slow mark me", "agent": "echo-agent"})
        tid = r["task"]["id"]
        self.live.wait_job(r["job"], states=("running",))
        self.live.json(f"api/tasks/{tid}", {"status": "done"})
        listed = {t["id"]: t for t in self.live.json("api/tasks")[1]}
        self.assertEqual((listed[tid]["status"], listed[tid]["job"]), ("done", "running"))
        self.live.json(f"api/jobs/{r['job']}/stop", {})
        self.live.wait_job(r["job"])
        self.assertNotIn(tid, [t["id"] for t in self.live.json("api/tasks")[1]])   # ended and done: gone
        _, r2 = self.live.json("api/send", {"text": "one more", "agent": "echo-agent", "task": tid})
        self.assertEqual(self.live.json(f"api/jobs?task={tid}")[1]["task"]["status"], "doing")
        self.live.wait_job(r2["job"])

    def test_a_step_cut_short_keeps_its_whole_text(self):
        """agent → core {"step", "full"}: the line stays short, the whole text is kept beside it (fulls: {line index: text}) for the shell's …"""
        long = "/long " + "x" * 100
        _, r = self.live.json("api/send", {"text": long, "agent": "echo-agent"})
        j = self.live.wait_job(r["job"])
        i = next(k for k, t in enumerate(j["lines"]) if t.startswith("📜 "))
        self.assertEqual(j["lines"][i], "📜 " + long[:40])
        self.assertTrue(j["fulls"][str(i)].startswith("📜 " + long))   # the prompt also carries its quotes block, if any
        self.assertEqual([k for k in j["fulls"]], [str(i)])   # only the line that was cut

    def test_the_queue_runs_first_then_waits_in_order(self):
        """GET /api/queue: the running jobs first, then the queued ones in the order they will run, numbered within their session, each
        with its task's title and ref. A session runs one task at a time; another session's first task runs beside it."""
        _, a = self.live.json("api/send", {"text": "/slow first job", "agent": "echo-agent", "ref": "app/sessions/7#n1"})
        self.live.wait_job(a["job"], states=("running",))
        _, b = self.live.json("api/send", {"text": "second\nmore lines", "agent": "echo-agent", "task": a["task"]["id"]})
        _, c = self.live.json("api/send", {"text": "same session, other task", "agent": "echo-agent", "ref": "app/sessions/7#n2"})
        _, d = self.live.json("api/send", {"text": "/slow another session", "agent": "echo-agent"})
        self.live.wait_job(d["job"], states=("running",))   # beside a: its session was free
        q = {j["id"]: j for j in self.live.json("api/queue")[1]}
        self.assertEqual([(q[x["job"]]["state"], q[x["job"]].get("pos")) for x in (a, b, c, d)], [("running", None), ("queued", 1), ("queued", 2), ("running", None)])
        order = [j["id"] for j in self.live.json("api/queue")[1]]
        self.assertLess(order.index(b["job"]), order.index(c["job"]))
        jb = q[b["job"]]
        self.assertEqual((jb["title"], jb["ref"], jb["text"]), ("/slow first job", "app/sessions/7#n1", "second"))   # the first line only
        self.assertEqual(jb["full"], "second\nmore lines")   # all of it, for the row's tooltip
        self.assertEqual(next(j for j in self.live.json(f"api/jobs?task={c['task']['id']}")[1]["jobs"] if j["id"] == c["job"])["pos"], 2)
        for x in (a, d):
            self.live.json(f"api/jobs/{x['job']}/stop", {})
        for x in (b, c):
            self.live.wait_job(x["job"])
        self.assertFalse([j for j in self.live.json("api/queue")[1] if j["id"] in (a["job"], b["job"], c["job"], d["job"])])

    def test_a_queued_job_moves_within_its_session(self):
        """POST /api/jobs/<id>/move {before?}: a waiting job goes in front of another waiting job of its session (none: last) and runs in
        that order. Another session's order does not move. 400 for a before outside its session, 409 once it runs, 404 for no such job."""
        _, a = self.live.json("api/send", {"text": "/slow hold the session", "agent": "echo-agent", "ref": "app/sessions/9#n1"})
        self.live.wait_job(a["job"], states=("running",))
        b, c, d = (self.live.json("api/send", {"text": f"/slow {t}", "agent": "echo-agent", "ref": f"app/sessions/9#{t}"})[1] for t in ("b", "c", "d"))
        _, x = self.live.json("api/send", {"text": "/slow other session", "agent": "echo-agent", "ref": "app/sessions/10#x"})
        _, y = self.live.json("api/send", {"text": "waits in the other session", "agent": "echo-agent", "task": x["task"]["id"]})
        self.live.wait_job(x["job"], states=("running",))
        mine = lambda: [j["id"] for j in self.live.json("api/queue")[1] if j["state"] == "queued" and j["ref"].startswith("app/sessions/9")]
        code, r = self.live.json(f"api/jobs/{d['job']}/move", {"before": b["job"]})
        self.assertEqual((code, r["pos"]), (200, 1))
        self.assertEqual(mine(), [d["job"], b["job"], c["job"]])
        self.assertEqual(self.live.json(f"api/jobs/{d['job']}/move", {})[0], 200)   # none: last
        self.assertEqual(mine(), [b["job"], c["job"], d["job"]])
        self.assertEqual(self.live.json(f"api/jobs/{c['job']}/move", {"before": b["job"]})[0], 200)
        self.assertEqual(self.live.json(f"api/jobs/{b['job']}/move", {"before": y["job"]})[0], 400)   # another session's job
        self.assertEqual(self.live.json(f"api/jobs/{b['job']}/move", {"before": b["job"]})[0], 400)
        self.assertEqual(self.live.json(f"api/jobs/{a['job']}/move", {})[0], 409)   # it runs
        self.assertEqual(self.live.json("api/jobs/nope/move", {})[0], 404)
        self.assertEqual(next(j for j in self.live.json("api/queue")[1] if j["id"] == y["job"])["pos"], 1)   # the other session is as it was
        self.live.json(f"api/jobs/{a['job']}/stop", {})
        self.live.wait_job(c["job"], states=("running",), task=c["task"]["id"])   # c, moved first, runs next
        self.assertEqual(next(j for j in self.live.json(f"api/jobs?task={b['task']['id']}")[1]["jobs"] if j["id"] == b["job"])["state"], "queued")
        for j in (b, d, c, x, y):
            self.live.json(f"api/jobs/{j['job']}/stop", {})
        for j in (b, c, d, y):
            self.live.wait_job(j["job"], task=j["task"]["id"])

    def test_a_task_carries_a_ref(self):
        """ref: where an app keeps the task (the shell bundles by the part before #). Stored as given, never read; one line, 300 at most."""
        _, t = self.live.json("api/tasks", {"title": "with ref", "ref": "robosim-live/sessions/12#n7-3"})
        listed = {x["id"]: x for x in self.live.json("api/tasks")[1]}
        self.assertEqual(listed[t["id"]]["ref"], "robosim-live/sessions/12#n7-3")
        self.assertEqual(self.live.json(f"api/tasks/{t['id']}", {"ref": "robosim-live/sessions/13#n1"})[1]["ref"], "robosim-live/sessions/13#n1")
        self.assertEqual(self.live.json(f"api/tasks/{t['id']}", {"title": "renamed"})[1]["ref"], "robosim-live/sessions/13#n1")   # untouched when not given
        for bad in ("a\nb", "x" * 301, 7):
            self.assertEqual(self.live.call("api/tasks", {"title": "bad", "ref": bad})[0], 400, bad)
        _, r = self.live.json("api/send", {"text": "new with ref", "agent": "echo-agent", "ref": "img3d/sessions/4#n3"})
        self.assertEqual(r["task"]["ref"], "img3d/sessions/4#n3")
        self.live.wait_job(r["job"])
        self.assertEqual(self.live.json("api/tasks", {"title": "no ref"})[1]["ref"], "")

    def test_a_store_from_before_ref_gets_the_column(self):
        import sqlite3
        from aether.store import Store
        db = Path(tempfile.mkdtemp()) / "old.db"
        with sqlite3.connect(db) as c:
            c.execute("create table tasks (id text primary key, title text not null, status text not null default 'doing', ts real not null)")
            c.execute("insert into tasks values ('t1', 'old', 'doing', 1)")
        s = Store(db)
        self.assertEqual(s.task("t1")["ref"], "")
        self.assertEqual(s.update_task("t1", ref="app/sessions/1#a")["ref"], "app/sessions/1#a")

    def test_a_running_task_shows_running_and_counts_its_queue(self):
        """One job runs and the next of the same task waits: the task says running (not queued) and 1 queued."""
        _, r = self.live.json("api/send", {"text": "/slow first", "agent": "echo-agent"})
        tid = r["task"]["id"]
        self.live.wait_job(r["job"], states=("running",))
        _, r2 = self.live.json("api/send", {"text": "second", "agent": "echo-agent", "task": tid})
        t = next(x for x in self.live.json("api/tasks")[1] if x["id"] == tid)
        self.assertEqual((t["job"], t["queued"]), ("running", 1))
        self.live.json(f"api/jobs/{r['job']}/stop", {})
        self.live.wait_job(r2["job"])
        t = next(x for x in self.live.json("api/tasks")[1] if x["id"] == tid)
        self.assertEqual((t["job"], t["queued"]), ("done", 0))

    def test_inject_and_stop(self):
        _, r = self.live.json("api/send", {"text": "/slow one", "agent": "echo-agent"})
        self.live.wait_job(r["job"], states=("running",))
        time.sleep(0.3)
        _, i = self.live.json("api/send", {"text": "and two", "inject": r["job"]})
        self.assertTrue(i["injected"])
        j = self.live.wait_job(r["job"])
        self.assertIn("↪ and two", j["reply"])
        _, r = self.live.json("api/send", {"text": "/slow stop me", "agent": "echo-agent"})
        self.live.wait_job(r["job"], states=("running",))
        self.live.json(f"api/jobs/{r['job']}/stop", {})
        self.assertEqual(self.live.wait_job(r["job"])["state"], "stopped")
        _, late = self.live.json("api/send", {"text": "late", "inject": r["job"]})
        self.assertFalse(late["injected"])   # ended → queued next in the same conversation
        self.assertEqual(self.live.wait_job(late["job"])["state"], "done")

    def test_a_queued_message_can_be_added_to_and_edited(self):
        """POST /api/send {append|edit: job}: a waiting message is added to or rewritten in place (same id, same place). Once it runs,
        an edit changes nothing (409) and an append goes in as an inject."""
        _, a = self.live.json("api/send", {"text": "/slow keep busy", "agent": "echo-agent", "ref": "edit/sessions/1#a"})
        tid = a["task"]["id"]
        self.live.wait_job(a["job"], states=("running",))
        _, b = self.live.json("api/send", {"text": "look at @1", "agent": "echo-agent", "task": tid, "quotes": [{"n": 1, "label": "📄 a.md", "text": "A"}]})
        _, r = self.live.json("api/send", {"text": "and @1 too", "append": b["job"], "quotes": [{"n": 1, "label": "📄 b.md", "text": "B"}]})
        self.assertEqual(r, {"job": b["job"], "append": True})
        jb = next(j for j in self.live.json("api/queue")[1] if j["id"] == b["job"])
        self.assertEqual((jb["state"], jb["text"], jb["quotes"]), ("queued", "look at @1", [{"n": 1, "label": "📄 a.md"}, {"n": 2, "label": "📄 b.md"}]))
        self.assertNotIn("prompt", jb)
        full = next(j for j in self.live.json(f"api/jobs?task={tid}")[1]["jobs"] if j["id"] == b["job"])
        self.assertEqual(full["text"], "look at @1\n\nand @2 too")
        _, r = self.live.json("api/send", {"text": "rewritten @1", "edit": b["job"], "quotes": [{"n": 1, "label": "📄 c.md", "text": "C"}]})
        self.assertEqual(r, {"job": b["job"], "edit": True})
        _, c = self.live.json("api/send", {"text": "a new task's first words", "agent": "echo-agent", "ref": "edit/sessions/1#c"})   # waits: its session runs a
        self.live.json("api/send", {"text": "its better first words", "edit": c["job"]})
        self.assertEqual(self.live.json(f"api/jobs?task={c['task']['id']}")[1]["task"]["title"], "its better first words")   # named after it: follows
        self.assertEqual(self.live.call("api/send", {"text": "too late", "edit": a["job"]})[0], 409)
        time.sleep(0.3)
        _, r = self.live.json("api/send", {"text": "more for the running one", "append": a["job"]})
        self.assertTrue(r["injected"])
        self.assertEqual(self.live.call("api/send", {"text": "x", "edit": "nope"})[0], 404)
        self.live.json(f"api/jobs/{a['job']}/stop", {})
        jb = self.live.wait_job(b["job"])
        self.assertTrue(jb["reply"].startswith("Echo: rewritten @1"))
        self.assertIn("@1 📄 c.md", jb["reply"])
        self.assertNotIn("a.md", jb["reply"])
        self.live.wait_job(c["job"])
        _, r = self.live.json("api/send", {"text": "after the end", "append": b["job"]})
        self.assertEqual((r["injected"], self.live.wait_job(r["job"])["state"]), (False, "done"))   # ended: next in the same conversation

    def test_parallel_send_runs_beside_the_queue(self):
        """POST /api/jobs/<id>/parallel: a message that waits for its busy session moves to a new task of its own and runs now.
        409 once it runs or ended, 404 for no such job."""
        _, a = self.live.json("api/send", {"text": "/slow keep the session busy", "agent": "echo-agent"})
        self.live.wait_job(a["job"], states=("running",))
        _, c = self.live.json("api/send", {"text": "/slow same task as a", "agent": "echo-agent", "task": a["task"]["id"]})
        time.sleep(0.6)
        self.assertEqual(next(j for j in self.live.json("api/queue")[1] if j["id"] == c["job"])["state"], "queued")   # its session runs a
        code, r = self.live.json(f"api/jobs/{c['job']}/parallel", {})
        self.assertEqual(code, 200)
        self.assertNotEqual(r["task"]["id"], a["task"]["id"])
        self.assertEqual(r["task"]["title"], "/slow same task as a")
        jc = self.live.wait_job(c["job"], states=("running",), task=r["task"]["id"])   # beside a, in its new task
        self.assertNotIn("continuing", jc["lines"][0])   # a session of its own: a new conversation
        self.assertEqual(self.live.json(f"api/jobs/{a['job']}/parallel", {})[0], 409)
        self.assertEqual(self.live.json("api/jobs/nope/parallel", {})[0], 404)
        for x in (a, c):
            self.live.json(f"api/jobs/{x['job']}/stop", {})
        self.assertEqual(self.live.wait_job(c["job"], task=r["task"]["id"])["state"], "stopped")

    def test_parallel_send_at_send_time(self):
        """POST /api/send {parallel: true}: to a busy session, the message becomes a new task of its own and runs now, beside it;
        to a free one it is sent as it is. Not with first; a quote another session edits still needs approval."""
        _, a = self.live.json("api/send", {"text": "/slow keep the session busy", "agent": "echo-agent"})
        self.live.wait_job(a["job"], states=("running",))
        code, r = self.live.json("api/send", {"text": "/slow beside a\nmore words", "agent": "echo-agent", "task": a["task"]["id"], "parallel": True})
        self.assertEqual(code, 200)
        self.assertTrue(r["parallel"])
        self.assertNotEqual(r["task"]["id"], a["task"]["id"])
        self.assertEqual(r["task"]["title"], "/slow beside a")   # named after its first line
        jr = self.live.wait_job(r["job"], states=("running",), task=r["task"]["id"])   # runs now, beside a
        self.assertNotIn("continuing", jr["lines"][0])   # a session of its own: a new conversation
        self.assertEqual(self.live.json("api/send", {"text": "x", "agent": "echo-agent", "task": a["task"]["id"], "first": True, "parallel": True})[0], 400)
        _, d = self.live.json("api/send", {"text": "a free session", "agent": "echo-agent"})
        self.live.wait_job(d["job"])
        code, e = self.live.json("api/send", {"text": "free: as it is", "agent": "echo-agent", "task": d["task"]["id"], "parallel": True})
        self.assertEqual((code, e["task"]["id"], "parallel" in e), (200, d["task"]["id"], False))   # nothing waits there: no new task
        _, w = self.live.json("api/send", {"text": "/slow edit the docs", "agent": "echo-agent", "quotes": [{"n": 1, "label": "📁 docs/", "text": ""}]})
        self.live.wait_job(w["job"], states=("running",))
        md = [{"n": 1, "label": "📄 docs/intro.md", "text": "x"}]
        self.assertEqual(self.live.json("api/send", {"text": "parallel fix @1", "agent": "echo-agent", "task": w["task"]["id"], "quotes": md, "parallel": True})[0], 409)   # ⚡ would run it beside w: asks
        self.assertEqual(self.live.json("api/send", {"text": "parallel fix @1", "agent": "echo-agent", "task": w["task"]["id"], "quotes": md, "parallel": True, "confirm": True})[0], 200)
        for x in (a, r, w):
            self.live.json(f"api/jobs/{x['job']}/stop", {})
        for x in (a, r, w):
            self.live.wait_job(x["job"])

    def test_one_task_per_session(self):
        """A session (a task's ref up to #) runs one task at a time: a second task of the same session waits; another session's
        first task starts at once, beside it, without asking."""
        _, a = self.live.json("api/send", {"text": "/slow first of session 31", "agent": "echo-agent", "ref": "app/sessions/31#n1"})
        self.live.wait_job(a["job"], states=("running",))
        _, b = self.live.json("api/send", {"text": "/slow second of session 31", "agent": "echo-agent", "ref": "app/sessions/31#n2"})
        _, c = self.live.json("api/send", {"text": "/slow first of session 32", "agent": "echo-agent", "ref": "app/sessions/32#n1"})
        self.assertNotEqual(a["task"]["id"], b["task"]["id"])
        self.live.wait_job(c["job"], states=("running",))
        time.sleep(0.6)
        q = {j["id"]: j for j in self.live.json("api/queue")[1]}
        self.assertEqual((q[a["job"]]["state"], q[b["job"]]["state"], q[c["job"]]["state"]), ("running", "queued", "running"))
        self.live.json(f"api/jobs/{a['job']}/stop", {})
        self.live.wait_job(b["job"], states=("running",))   # session 31 is free again: its next task starts
        for j in (b, c):
            self.live.json(f"api/jobs/{j['job']}/stop", {})
            self.live.wait_job(j["job"])

    def test_a_send_that_quotes_what_another_task_edits_needs_approval(self):
        """409 conflict when another session's running job quotes the same file or folder; confirm: true sends it. Same for ⚡ and ✎ / ➕."""
        _, a = self.live.json("api/send", {"text": "/slow edit the docs", "agent": "echo-agent", "quotes": [{"n": 1, "label": "📁 docs/", "text": ""}]})
        self.live.wait_job(a["job"], states=("running",))
        md = [{"n": 1, "label": "📄 docs/intro.md · Intro", "text": "x"}]
        code, r = self.live.json("api/send", {"text": "fix @1", "agent": "echo-agent", "quotes": md})
        self.assertEqual(code, 409)
        self.assertEqual(r["conflict"], [{"job": a["job"], "task": a["task"]["id"], "title": "/slow edit the docs", "paths": ["docs"]}])
        self.assertNotIn("fix @1", [t["title"] for t in self.live.json("api/tasks?all=1")[1]])   # nothing was sent
        code, _ = self.live.json("api/send", {"text": "other file", "agent": "echo-agent", "quotes": [{"n": 1, "label": "📄 docsx/a.md", "text": ""}]})
        self.assertEqual(code, 200)   # docsx is not inside docs
        code, b = self.live.json("api/send", {"text": "same task is fine", "agent": "echo-agent", "task": a["task"]["id"], "quotes": md})
        self.assertEqual(code, 200)   # its own session: it waits for a anyway
        self.assertEqual(self.live.json(f"api/jobs/{b['job']}/parallel", {})[0], 409)   # ⚡ would run it beside a: asks
        code, r = self.live.json(f"api/jobs/{b['job']}/parallel", {"confirm": True})
        self.assertEqual(code, 200)
        _, x = self.live.json("api/send", {"text": "/slow busy session 41", "agent": "echo-agent", "ref": "s/sessions/41#x"})
        self.live.wait_job(x["job"], states=("running",))
        _, c = self.live.json("api/send", {"text": "plain", "agent": "echo-agent", "ref": "s/sessions/41#c"})   # waits for x
        self.assertEqual(self.live.json("api/send", {"text": "and @1", "append": c["job"], "quotes": md})[0], 409)
        self.assertEqual(self.live.json("api/send", {"text": "and @1", "append": c["job"], "quotes": md, "confirm": True})[0], 200)
        code, _ = self.live.json("api/send", {"text": "fix @1", "agent": "echo-agent", "quotes": md, "confirm": True})
        self.assertEqual(code, 200)
        for j in (a, x):
            self.live.json(f"api/jobs/{j['job']}/stop", {})
        self.live.wait_job(b["job"], task=r["task"]["id"])
        self.live.wait_job(c["job"])

    def test_reload_swaps_good_code_without_waiting(self):
        """--reload: a file that does not compile keeps the old code; good code hands the running jobs over and swaps (execv) at once."""
        from aether.reload import Reloader
        root = Path(tempfile.mkdtemp())
        (root / "mod.py").write_text("x = 1\n")
        calls, logs = [], []
        runner = self.live.srv.core.runner
        rl = Reloader(self.live.srv.core, ["--port", "1"], log=logs.append, root=root, execv=lambda *a: calls.append(a), settle=0.05)
        self.assertFalse(rl.step())   # nothing changed
        time.sleep(0.02)
        (root / "mod.py").write_text("x = (\n")
        self.assertFalse(rl.step())
        self.assertIn("kept the running code", logs[-1])
        self.assertFalse(runner.hold)
        _, a = self.live.json("api/send", {"text": "/slow busy while new code arrives", "agent": "echo-agent"})
        self.live.wait_job(a["job"], states=("running",))
        time.sleep(0.02)
        (root / "mod.py").write_text("x = 2\n")
        try:
            self.assertTrue(rl.step())   # a job runs: it is handed over, not waited for
            self.assertEqual(calls[-1][1][1:], ["-m", "aether", "--port", "1"])
            hand = json.loads(os.environ.pop("AETHER_HANDOFF"))
            self.assertIn(a["job"], [h["job"] for h in hand])
            self.assertTrue(runner.hold and runner.handing)
        finally:
            runner.release()   # this process is not replaced in a test: carry on
        self.live.json(f"api/jobs/{a['job']}/stop", {})
        self.assertEqual(self.live.wait_job(a["job"])["state"], "stopped")

    def test_a_handed_over_job_runs_on_in_the_next_runner(self):
        """Runner.handoff → a new Runner adopts the job (same agent process, same pipes) and follows it to the end, injects included."""
        from aether.runner import Runner
        live = Live()
        try:
            core = live.srv.core
            _, a = live.json("api/send", {"text": "/slow handed over", "agent": "echo-agent"})
            live.wait_job(a["job"], states=("running",))
            time.sleep(0.3)
            hand = json.loads(json.dumps(core.runner.handoff()))   # as it travels through the environment
            nxt = Runner(core.store, lambda: core.ext()["agent"], core.ws, [], core.data / "logs")
            nxt.start(handoff=hand)
            core.runner = nxt
            self.assertEqual(live.json(f"api/jobs?task={a['task']['id']}")[1]["jobs"][-1]["state"], "running")   # not "server restarted"
            _, i = live.json("api/send", {"text": "after the swap", "inject": a["job"]})
            self.assertTrue(i["injected"])
            j = live.wait_job(a["job"])
            self.assertEqual(j["state"], "done")
            self.assertIn("↪ after the swap", j["reply"])
        finally:
            live.close()

    def test_files_and_frames(self):
        code, f = self.live.json("api/files?path=samples")
        self.assertEqual(code, 200)
        self.assertIn("hello-app", [i["name"] for i in f["items"] if i.get("app")])
        self.assertEqual(self.live.call("api/files?path=..")[0], 403)
        self.assertEqual(self.live.call("api/read?path=../aether/server.py")[0], 403)
        code, h, _ = self.live.call("files/samples/hello-app/index.html")
        self.assertEqual(code, 200)
        self.assertEqual(h["Content-Security-Policy"], "sandbox allow-scripts allow-modals")   # modals: print (spec 3)
        _, _, page = self.live.call("x/md-preview/index.html")
        self.assertIn(b"window.aether", page)   # the SDK is inlined (a sandboxed page behind a proxy cannot fetch it)
        self.assertNotIn(b'<script src="aether-sdk.js"></script>', page)
        code, h, body = self.live.call("x/md-preview/aether-sdk.js")
        self.assertEqual(code, 200)
        self.assertIn(b"window.aether", body)
        for name in (b"bar(", b"fullscreen("):   # a page's own controls in the shell's bar (spec 3.1)
            self.assertIn(name, body)
        self.assertEqual(self.live.call("x/md-preview/../../../aether/server.py")[0], 403)
        self.assertEqual(self.live.call("files/../aether/server.py")[0], 403)

    def test_md_and_pptx_previews_bundle(self):
        for ext in ("md-preview", "pptx-preview"):
            code, _, page = self.live.call(f"x/{ext}/index.html")
            self.assertEqual(code, 200)
            for tag in (b'<script src="view.js">', b'<link rel="stylesheet" href="view.css">'):
                self.assertNotIn(tag, page)   # inlined
            for use in (b"aether.bar(", b"aether.quote(", b"aether.scrolled(", b"aether.download()"):
                self.assertIn(use, page)
        _, _, md = self.live.call("x/md-preview/index.html")
        self.assertIn(b'aether.read("mermaid.min.js")', md)
        code, _, js = self.live.call("x/md-preview/mermaid.min.js")
        self.assertEqual(code, 200)
        self.assertGreater(len(js), 1_000_000)


class Unlocked(unittest.TestCase):
    def test_config_unlocks(self):
        live = Live(config={"core_locked": False})
        try:
            self.assertFalse(live.json("api/info")[1]["locked"])
        finally:
            live.close()

    def test_rule(self):
        """Unlocked by a workspace that holds the core's own clone; config core_locked (either way) wins; a pip install never."""
        top = Path(tempfile.mkdtemp()).resolve()
        repo = top / "aether-rsi"
        for d in ("aether", "spec", "conformance", "projects"):
            (repo / d).mkdir(parents=True)
        self.assertFalse(lock_state(None, top, repo)[0])
        self.assertFalse(lock_state(None, repo, repo)[0])
        self.assertTrue(lock_state(None, repo / "projects", repo)[0])
        self.assertTrue(lock_state(None, None, repo)[0])
        self.assertTrue(lock_state(True, top, repo)[0])
        self.assertFalse(lock_state(False, repo / "projects", repo)[0])
        site = top / "venv/lib/python3.12/site-packages"
        for d in ("aether", "spec", "conformance"):
            (site / d).mkdir(parents=True)
        locked, why = lock_state(None, top, site)
        self.assertTrue(locked)
        self.assertIn("installed package", why)

    def test_workspace_holding_the_core(self):
        live = Live(str(REPO))
        try:
            info = live.json("api/info")[1]
            self.assertFalse(info["locked"])
            self.assertIn("contains the core", info["lock_reason"])
            self.assertEqual(live.call("api/read?path=aether/__init__.py")[0], 200)
        finally:
            live.close()
        forced = Live(str(REPO), config={"core_locked": True})
        try:
            self.assertTrue(forced.json("api/info")[1]["locked"])
            self.assertNotEqual(forced.call("api/read?path=aether/__init__.py")[0], 200)
        finally:
            forced.close()

    def test_switching_the_workspace_relocks(self):
        live = Live("")
        try:
            live.json("api/config", {"workspace": str(REPO)})
            self.assertFalse(live.json("api/info")[1]["locked"])
            live.json("api/config", {"workspace": tempfile.mkdtemp()})
            self.assertTrue(live.json("api/info")[1]["locked"])
        finally:
            live.close()


class Workspace(unittest.TestCase):
    """A fresh install has no workspace: the shell asks for the folder, the core checks it and keeps it in config.json."""

    def setUp(self):
        self.live = Live("")

    def tearDown(self):
        self.live.close()

    def test_fresh_install_asks(self):
        info = self.live.json("api/info")[1]
        self.assertEqual((info["workspace"], info["workspace_path"], info["workspace_fixed"]), ("", "", False))
        for path in ("api/files?path=", "api/read?path=x.md", "files/x/index.html"):
            self.assertEqual(self.live.call(path)[0], 409, path)
        self.assertEqual(self.live.call("api/send", {"text": "hi", "agent": "echo-agent"})[0], 409)

    def test_set_checks_and_saves(self):
        ws = Path(tempfile.mkdtemp()).resolve()
        (ws / "a.md").write_text("# a")
        for bad in ("", "relative/dir", str(ws / "missing"), str(Path.home()), "/", str(ws / "a.md")):
            self.assertEqual(self.live.call("api/config", {"workspace": bad})[0], 400, bad)
        self.assertEqual(self.live.json("api/config", {"workspace": str(ws)})[1]["workspace"], str(ws))
        self.assertEqual(self.live.json("api/info")[1]["workspace_path"], str(ws))
        self.assertEqual([i["name"] for i in self.live.json("api/files?path=")[1]["items"]], ["a.md"])
        self.assertEqual(json.loads((self.live.data / "config.json").read_text())["workspace"], str(ws))
        again = Live("", config={"workspace": str(ws)})   # the next start uses it
        try:
            self.assertEqual(again.json("api/info")[1]["workspace"], ws.name)
        finally:
            again.close()

    def test_recent(self):
        """Each change puts the folder first (the one left right after it, no repeats); only existing ones are offered; the shell cannot write it."""
        a, b, c = (Path(tempfile.mkdtemp()).resolve() for _ in range(3))
        self.assertEqual(self.live.json("api/info")[1]["recent"], [])
        for ws in (a, b, c, a):
            self.live.json("api/config", {"workspace": str(ws)})
        self.assertEqual(self.live.json("api/info")[1]["recent"], [str(a), str(c), str(b)])
        c.rmdir()
        self.assertEqual(self.live.json("api/info")[1]["recent"], [str(a), str(b)])
        self.assertEqual(json.loads((self.live.data / "config.json").read_text())["recent"], [str(a), str(c), str(b)])   # kept: it may come back
        self.assertEqual(self.live.call("api/config", {"recent": ["/tmp"]})[0], 400)
        started = Live("", config={"workspace": str(b)})   # a workspace saved before recent existed is not lost on the first switch
        try:
            started.json("api/config", {"workspace": str(a)})
            self.assertEqual(started.json("api/info")[1]["recent"], [str(a), str(b)])
        finally:
            started.close()

    def test_extension_page_cannot_set_it(self):
        self.assertEqual(self.live.call("api/config", {"workspace": "/tmp"}, {"X-Aether": ""})[0], 403)
        self.assertEqual(self.live.call("api/config", {"workspace": "/tmp"}, {"Origin": "null"})[0], 403)   # a sandboxed frame

    def test_missing_saved_folder_asks_again(self):
        gone = Live("", config={"workspace": "/no/such/folder"})
        try:
            info = gone.json("api/info")[1]
            self.assertEqual(info["workspace"], "")
            self.assertIn("not usable", info["workspace_error"])
        finally:
            gone.close()

    def test_flag_fixes_it(self):
        ws = Path(tempfile.mkdtemp()).resolve()
        fixed = Live(str(ws))
        try:
            self.assertTrue(fixed.json("api/info")[1]["workspace_fixed"])
            self.assertEqual(fixed.call("api/config", {"workspace": tempfile.mkdtemp()})[0], 400)
        finally:
            fixed.close()


class Install(unittest.TestCase):
    """pip install aether-rsi: the shell ships inside the package; the workspace is set in the page (or --workspace), never your home."""

    def test_static_is_package_data(self):
        text = (REPO / "pyproject.toml").read_text()
        self.assertIn('aether = ["static/*", "fallback/*/*/*"]', text)
        self.assertFalse([p for p in (REPO / "aether/static").iterdir() if p.is_dir()])  # static/* is not recursive
        spare = [p for p in (REPO / "aether/fallback").rglob("*") if p.is_file() and "__pycache__" not in p.parts]
        self.assertTrue(spare)
        self.assertTrue(all(len(p.relative_to(REPO / "aether/fallback").parts) == 3 for p in spare))   # fallback/<group>/<agent>/<file>: what the glob ships

    def test_workspace_default(self):
        from aether import __main__ as m
        old = os.environ.pop("AETHER_WORKSPACE", None)
        try:
            self.assertEqual(m.default_workspace(), "")   # neither the clone's projects/ nor the current folder: the page asks
            os.environ["AETHER_WORKSPACE"] = "/w"
            self.assertEqual(m.default_workspace(), "/w")
        finally:
            os.environ.pop("AETHER_WORKSPACE", None)
            if old is not None:
                os.environ["AETHER_WORKSPACE"] = old

    def test_refuses_home(self):
        from aether import __main__ as m
        self.assertEqual(m.main(["--workspace", str(Path.home()), "--port", "0"]), 2)


if __name__ == "__main__":
    unittest.main()
