"""The core: path guard, prompt composition, and the HTTP API driven end to end through the echo agent."""

import os
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import REPO, Live
from aether import files
from aether.runner import compose
from aether.server import bundle


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
        self.assertEqual({a["id"] for a in i["agents"]}, {"claude-code", "echo-agent"})
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

    def test_files_and_frames(self):
        code, f = self.live.json("api/files?path=")
        self.assertEqual(code, 200)
        self.assertIn("hello-app", [i["name"] for i in f["items"] if i.get("app")])
        self.assertEqual(self.live.call("api/files?path=..")[0], 403)
        self.assertEqual(self.live.call("api/read?path=../aether/server.py")[0], 403)
        code, h, _ = self.live.call("files/hello-app/index.html")
        self.assertEqual(code, 200)
        self.assertEqual(h["Content-Security-Policy"], "sandbox allow-scripts")
        _, _, page = self.live.call("x/md-preview/index.html")
        self.assertIn(b"window.aether", page)   # the SDK is inlined (a sandboxed page behind a proxy cannot fetch it)
        self.assertNotIn(b'<script src="aether-sdk.js"></script>', page)
        code, h, body = self.live.call("x/md-preview/aether-sdk.js")
        self.assertEqual(code, 200)
        self.assertIn(b"window.aether", body)
        self.assertEqual(self.live.call("x/md-preview/../../../aether/server.py")[0], 403)
        self.assertEqual(self.live.call("files/../aether/server.py")[0], 403)


class Unlocked(unittest.TestCase):
    def test_config_unlocks(self):
        live = Live(config={"core_locked": False})
        try:
            self.assertFalse(live.json("api/info")[1]["locked"])
        finally:
            live.close()


if __name__ == "__main__":
    unittest.main()
