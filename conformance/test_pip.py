"""pip install aether-rsi, emulated: build this repo into a fresh venv with its own HOME and run the installed `aether` from there.
Opt-in (AETHER_PIP_TEST=1): pip fetches setuptools to build, the only test that reaches beyond 127.0.0.1.
AETHER_PIP_SRC=head (default) installs what is committed (`git archive HEAD`, what a clone gets); worktree installs the files as they are."""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from conformance.helpers import REPO

ON = os.environ.get("AETHER_PIP_TEST") == "1"
SRC = os.environ.get("AETHER_PIP_SRC") or "head"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(ON, "set AETHER_PIP_TEST=1 (pip fetches setuptools from the network)")
class Pip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="aether-pip-")).resolve()
        src, home = cls.tmp / "src", cls.tmp / "home"
        home.mkdir()
        if SRC == "head":
            src.mkdir()
            tar = subprocess.run(["git", "-C", str(REPO), "archive", "HEAD"], capture_output=True, check=True).stdout
            subprocess.run(["tar", "-x", "-C", str(src)], input=tar, check=True)
        else:   # a copy, so the build never writes build/ or *.egg-info into the checkout
            shutil.copytree(REPO, src, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "build", "*.egg-info", "settings.json"))
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith(("AETHER_", "PYTHON"))}
        cls.env["HOME"] = str(home)   # ~/.aether-rsi (data, config, settings) is the test's own, never this machine's
        venv = cls.tmp / "venv"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        cls.py, cls.aether = venv / "bin" / "python", venv / "bin" / "aether"
        r = subprocess.run([str(cls.py), "-m", "pip", "install", "-q", "--disable-pip-version-check", str(src)],
                           capture_output=True, text=True, env=cls.env, cwd=str(cls.tmp))
        if r.returncode:
            raise AssertionError(f"pip install failed:\n{r.stdout}{r.stderr}")
        cls.home, cls.venv = home, venv

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_aether(self, *args, cwd=None):
        return subprocess.run([str(self.aether), *args], capture_output=True, text=True, timeout=60, env=self.env,
                              cwd=str(cwd or self.tmp), stdin=subprocess.DEVNULL)

    def serve(self, ws):
        """Start the installed core on a free port; (process, info) once /api/info answers."""
        port = free_port()
        p = subprocess.Popen([str(self.aether), "--port", str(port), "--workspace", str(ws)], env=self.env,   # stdin is no terminal: never asked
                             cwd=str(self.tmp), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.addCleanup(lambda: (p.terminate(), p.wait(10), p.stdout.close()))
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):   # until it answers, not a fixed sleep
            try:
                with urllib.request.urlopen(base + "/api/info", timeout=2) as r:
                    return base, json.loads(r.read())
            except OSError:
                if p.poll() is not None:
                    self.fail(f"the core exited: {p.stdout.read().decode(errors='replace')}")
                time.sleep(0.1)
        self.fail("the core did not answer /api/info")

    def test_imports_from_the_venv(self):
        r = subprocess.run([str(self.py), "-c", "import aether; print(aether.__file__)"], capture_output=True, text=True, env=self.env,
                           cwd=str(self.tmp))
        self.assertIn("site-packages", r.stdout)
        self.assertNotIn(str(REPO), r.stdout)

    def test_help(self):
        r = self.run_aether("--help")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("AetherRSI", r.stdout)

    def test_fallbacks_ship_and_pass_check(self):
        pkg = next(self.venv.glob("lib/python*/site-packages/aether"))
        for d in ("fallback/agent/claude-code", "fallback/preview/text-preview"):
            r = self.run_aether("check", str(pkg / d))
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_init_then_serve(self):
        r = self.run_aether("init", "P")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)   # the README promises `aether init`
        ws = self.tmp / "P"
        self.assertTrue((ws / "apps/hello-app/aether.json").is_file())
        self.assertEqual(json.loads((self.home / ".aether-rsi/config.json").read_text())["workspace"], str(ws))
        base, info = self.serve(ws)
        self.assertEqual(info["errors"], [])
        self.assertTrue(info["locked"])
        self.assertIn("echo-agent", [a["id"] for a in info["agents"]])
        self.assertIn("md-preview", [p["id"] for p in info["previews"]])
        with urllib.request.urlopen(base + "/", timeout=5) as page:
            self.assertEqual(page.status, 200)

    def test_installed_core_stays_locked(self):
        _, info = self.serve(self.tmp)   # the workspace holds the venv and so the installed core
        self.assertTrue(info["locked"])
        self.assertIn("installed package", info["lock_reason"])


if __name__ == "__main__":
    unittest.main()
