"""`aether setup vertex`: how agents reach the models is set from a terminal (settings.json), shown on the page, never its key."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import REPO, Live


class Setup(unittest.TestCase):
    def setUp(self):
        self.was = os.environ["AETHER_SETTINGS"]
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.file = self.tmp / "settings.json"
        os.environ["AETHER_SETTINGS"] = str(self.file)
        self.key = self.tmp / "sa.json"
        self.key.write_text(json.dumps({"type": "service_account", "private_key": "secret-value"}))

    def tearDown(self):
        os.environ["AETHER_SETTINGS"] = self.was

    def cli(self, *args, env=None):
        e = dict(os.environ, PYTHONPATH=str(REPO))
        e.pop("AETHER_AGENT", None)
        return subprocess.run([sys.executable, "-m", "aether", "setup", "vertex", *args, "--data", str(self.tmp / "data")],
                              capture_output=True, text=True, timeout=30, env={**e, **(env or {})})

    def saved(self):
        return json.loads(self.file.read_text())["vertex"]

    def test_key_then_adc(self):
        self.file.write_text(json.dumps({"extensions": [], "env": {"A": "1"}}))
        r = self.cli("--project", "p1", "--key", str(self.key))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.saved(), {"credentials": str(self.key), "project": "p1", "region": "global"})
        self.assertEqual(json.loads(self.file.read_text())["env"], {"A": "1"})   # the rest of settings.json stays
        self.assertNotIn("secret-value", r.stdout + r.stderr)
        self.assertEqual(self.cli("--adc").returncode, 0)
        self.assertEqual(self.saved(), {"project": "p1", "region": "global"})
        r = self.cli()
        self.assertIn("project=p1", r.stdout)
        self.assertIn("ADC", r.stdout)

    def test_refuses_what_is_not_a_key(self):
        bad = self.tmp / "notes.json"
        bad.write_text('{"hello": 1}')
        for k in (bad, self.tmp / "missing.json"):
            r = self.cli("--project", "p1", "--key", str(k))
            self.assertEqual(r.returncode, 2, k)
        self.assertFalse(self.file.exists())

    def test_project_needed_first(self):
        self.assertEqual(self.cli("--region", "us-east5").returncode, 2)

    def test_refused_inside_an_agent(self):
        r = self.cli("--project", "evil", env={"AETHER_AGENT": "1"})
        self.assertEqual(r.returncode, 2)
        self.assertFalse(self.file.exists())

    def test_the_page_sees_the_state_not_the_key(self):
        self.assertEqual(self.cli("--project", "p1", "--key", str(self.key)).returncode, 0)
        t = time.time() + 1
        os.utime(self.file, (t, t))
        live = Live(Path(tempfile.mkdtemp()))
        try:
            info = live.json("api/info")[1]
            self.assertEqual(info["vertex"], {"project": "p1", "region": "global", "auth": "key"})
            self.assertNotIn(str(self.key), json.dumps(info))
            self.assertEqual(live.call("api/config", {"vertex": {"project": "evil"}})[0], 400)   # the page cannot set it
        finally:
            live.close()


if __name__ == "__main__":
    unittest.main()
