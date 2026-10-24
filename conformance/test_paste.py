"""Images pasted into ③: kept outside the workspace, nothing piles up (paste.py), and the claude-code agent hands them over as image blocks."""

import importlib.util
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import REPO
from aether import paste


class Pastes(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()) / "paste"
        self.prompts = []
        self.p = paste.Pastes(self.root, lambda: self.prompts)

    def add(self, body=b"\x89PNGxx", ctype="image/png"):
        return self.p.add(io.BytesIO(body), len(body), ctype)

    def age(self, name, seconds):
        t = time.time() - seconds
        os.utime(self.root / name, (t, t))

    def test_add_and_drop(self):
        r = self.add()
        self.assertTrue(Path(r["path"]).is_file())
        self.assertEqual(Path(r["path"]).parent, self.root)
        self.assertTrue(self.p.drop(r["name"]))
        self.assertFalse(Path(r["path"]).exists())
        self.assertEqual([x.name for x in self.root.iterdir()], [])   # no temp file left

    def test_refused(self):
        with self.assertRaises(ValueError):
            self.add(ctype="text/html")
        with self.assertRaises(ValueError):
            self.p.add(io.BytesIO(b"x"), paste.MAX + 1, "image/png")
        with self.assertRaises(ValueError):
            self.p.add(io.BytesIO(b"ab"), 5, "image/png")   # stops before its end
        for bad in ("../config.json", "x.png", "0123456789abcdef.svg", ""):
            with self.assertRaises(ValueError):
                self.p.path(bad)
        self.assertEqual([x.name for x in self.root.iterdir()], [])

    def test_old_ones_go_unless_quoted(self):
        old, used, new = self.add()["name"], self.add()["name"], self.add()["name"]
        self.age(old, paste.KEEP + 60)
        self.age(used, paste.KEEP + 60)
        self.prompts = [f"look\n\n---\nQuoted:\n@1 🖼 Pasted image 1\n> {self.root / used}"]
        self.assertEqual(self.p.sweep(), [old])
        self.assertEqual(sorted(x.name for x in self.root.iterdir()), sorted([used, new]))
        self.assertFalse(self.p.drop(used))   # ✕ while a waiting message quotes it: kept
        self.prompts = []
        self.assertEqual(self.p.sweep(), [used])   # that message ran: the next sweep takes it

    def test_cap_takes_the_oldest(self):
        names = [self.add(b"\x89PNG" + bytes(100))["name"] for _ in range(3)]
        for i, n in enumerate(names):
            self.age(n, 300 - i * 100)
        cap, paste.CAP = paste.CAP, 150   # 3 × 104 bytes: the two oldest go
        try:
            self.assertEqual(self.p.sweep(), names[:2])
        finally:
            paste.CAP = cap

    def test_locked_store_keeps_everything(self):
        n = self.add()["name"]
        self.age(n, paste.KEEP + 60)
        def locked():
            raise RuntimeError("database is locked")
        self.p.in_use = locked
        self.assertEqual(self.p.sweep(), [])
        self.assertTrue((self.root / n).is_file())


class AgentImage(unittest.TestCase):
    def test_pasted_image_becomes_a_block(self):
        spec = importlib.util.spec_from_file_location("cc_agent", REPO / "aether/fallback/agent/claude-code/agent.py")
        agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(agent)
        d = Path(tempfile.mkdtemp())
        img = d / "0123456789abcdef.png"
        img.write_bytes(b"\x89PNG")
        text = f"what is @1?\n\n---\nQuoted:\n@1 🖼 Pasted image 1\n> {img}\n\n@2 🖼 Pasted image 2\n> {d / 'fedcba9876543210.png'}"
        c = json.loads(agent.user(text))["message"]["content"]
        self.assertEqual(c[0], {"type": "text", "text": text})   # the path stays in the text
        self.assertEqual(c[1], {"type": "text", "text": "@1:"})
        self.assertEqual(c[2]["source"], {"type": "base64", "media_type": "image/png", "data": "iVBORw=="})
        self.assertEqual(len(c), 3)   # the one that is gone stays a path
        self.assertEqual(json.loads(agent.user("plain"))["message"]["content"], [{"type": "text", "text": "plain"}])


if __name__ == "__main__":
    unittest.main()
