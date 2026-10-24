"""pip install aether-rsi → `aether` asks once whether to make ./SampleProject (or `aether init [DIR]`); the wheel carries it."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from conformance.helpers import REPO
from aether import __main__ as m
from aether import extensions


class Init(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.data = self.tmp / "data"

    def test_sample_passes_check(self):
        roots = [m.SAMPLE / "apps" / "hello-app", *sorted((m.SAMPLE / "extensions").glob("*/*"))]
        self.assertGreaterEqual(len(roots), 4)
        for d in roots:
            self.assertEqual(extensions.check(str(d))[1], [], d)

    def test_sample_has_no_machine_paths(self):
        for p in m.SAMPLE.rglob("*"):
            if p.is_file() and p.suffix in (".md", ".json", ".py", ".html", ".css"):
                self.assertNotIn(str(Path.home()), p.read_text(errors="replace"), p)   # a public package carries nobody's home

    def test_init_makes_and_saves(self):
        self.assertEqual(m.init([str(self.tmp / "P"), "--data", str(self.data)]), 0)
        self.assertTrue((self.tmp / "P/apps/hello-app/aether.json").is_file())
        conf = json.loads((self.data / "config.json").read_text())
        self.assertEqual(conf["workspace"], str(self.tmp / "P"))
        self.assertEqual(conf["recent"], [str(self.tmp / "P")])

    def test_init_never_replaces(self):
        (self.tmp / "P").mkdir()
        (self.tmp / "P/mine.txt").write_text("keep")
        self.assertEqual(m.init([str(self.tmp / "P"), "--data", str(self.data)]), 0)
        self.assertEqual((self.tmp / "P/mine.txt").read_text(), "keep")
        self.assertTrue((self.tmp / "P-2/README.md").is_file())
        self.assertEqual(m.init([str(self.tmp / "P"), "--data", str(self.data)]), 0)
        self.assertTrue((self.tmp / "P-3").is_dir())
        self.assertEqual(json.loads((self.data / "config.json").read_text())["workspace"], str(self.tmp / "P-2"))   # a saved one is kept

    def test_init_keeps_other_config(self):
        self.data.mkdir()
        (self.data / "config.json").write_text(json.dumps({"agent": "echo-agent"}))
        m.init([str(self.tmp / "P"), "--data", str(self.data)])
        self.assertEqual(json.loads((self.data / "config.json").read_text())["agent"], "echo-agent")

    def test_no_question_without_a_terminal(self):
        env = dict(os.environ, AETHER_DATA=str(self.data))
        env.pop("AETHER_WORKSPACE", None)
        code = "import sys; from aether import __main__ as m; sys.argv=['aether','--port','0']; import aether.__main__ as mm; mm.serve=lambda *a: (_ for _ in ()).throw(SystemExit(0)); mm.main(['--port','0'])"
        r = subprocess.run([sys.executable, "-c", code], cwd=str(self.tmp), input="y\n", capture_output=True, text=True, timeout=60,
                           env=dict(env, PYTHONPATH=str(REPO)))
        self.assertNotIn("[Y/n]", r.stdout + r.stderr)   # piped stdin: CI and scripts are never asked
        self.assertFalse((self.tmp / "SampleProject").exists())


if __name__ == "__main__":
    unittest.main()
