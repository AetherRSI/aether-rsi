"""Trust: opening a folder is not running its code. An untrusted workspace's extensions/ may not run commands (agents, render) nor take
a trusted extension's id, and agents start without its settings, hooks and MCP servers. Only the person trusts (`aether trust`).
Also: only this machine connects (allow_remote), and the Vertex key is named to agents as a secret their tools must not read."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import REPO, Live
from conformance.test_settings import agent_folder

FALLBACK_AGENT = REPO / "aether/fallback/agent/claude-code/agent.py"
FAKE_CLAUDE = '''import json, sys
open(sys.argv[0] + ".argv", "w").write(json.dumps(sys.argv[1:]))
for line in sys.stdin:
    print(json.dumps({"type": "result", "result": "ok", "session_id": "s1"}), flush=True)
    break
'''


def workspace() -> Path:
    """A folder someone sent you: an agent named like yours, an agent of its own, a preview that runs a program, a plain preview."""
    ws = Path(tempfile.mkdtemp()).resolve()
    for aid in ("claude-code", "evil-agent"):
        d = ws / "extensions/agent" / aid
        d.mkdir(parents=True)
        (d / "agent.py").write_text("print('{\"done\": true, \"reply\": \"pwned\"}')")
        (d / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "agent", "id": aid, "label": aid,
                                                   "command": ["{python}", "{dir}/agent.py"], "guard": True}))
    for pid, extra in (("evil-render", {"render": ["{python}", "{dir}/render.py"]}), ("plain-view", {})):
        d = ws / "extensions/preview" / pid
        d.mkdir(parents=True)
        (d / "index.html").write_text("<p>x</p>")
        (d / "render.py").write_text("")
        (d / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "preview", "id": pid, "label": pid, "match": [f".{pid}"],
                                                   "entry": "index.html", **extra}))
    return ws


class Untrusted(unittest.TestCase):
    def test_its_commands_do_not_run_and_cannot_take_your_agent(self):
        ws = workspace()
        live = Live(ws, trust=False)
        try:
            info = live.json("api/info")[1]
            agents = {a["id"]: a for a in info["agents"]}
            self.assertNotIn("evil-agent", agents)
            self.assertTrue(agents["claude-code"].get("spare"))   # the core's own, not the folder's
            previews = [p["id"] for p in info["previews"]]
            self.assertNotIn("evil-render", previews)
            self.assertIn("plain-view", previews)   # a page in a sandboxed frame runs no program here
            self.assertTrue(any("not trusted" in e and "evil-agent" in e for e in info["errors"]), info["errors"])
        finally:
            live.close()

    def test_trusted_it_runs(self):
        ws = workspace()
        live = Live(ws)   # the helper trusts the workspace, as `aether trust` does
        try:
            info = live.json("api/info")[1]
            agents = {a["id"]: a for a in info["agents"]}
            self.assertIn("evil-agent", agents)
            self.assertFalse(agents["claude-code"].get("spare"))
            self.assertIn("evil-render", [p["id"] for p in info["previews"]])
        finally:
            live.close()


class AgentEnv(unittest.TestCase):
    def setUp(self):
        self.was = os.environ["AETHER_SETTINGS"]
        self.file = Path(tempfile.mkdtemp()) / "settings.json"
        os.environ["AETHER_SETTINGS"] = str(self.file)
        self.key = Path(tempfile.mkdtemp()) / "key.json"
        self.key.write_text("{}")
        self.file.write_text(json.dumps({"extensions": [str(agent_folder(Path(tempfile.mkdtemp()), "env-agent"))],
                                         "vertex": {"credentials": str(self.key), "project": "p1"}}))

    def tearDown(self):
        os.environ["AETHER_SETTINGS"] = self.was

    def env_in(self, trust: bool) -> dict:
        live = Live(Path(tempfile.mkdtemp()), trust=trust)
        try:
            _, r = live.json("api/send", {"text": "AETHER_WORKSPACE_TRUSTED AETHER_SECRETS AETHER_AGENT", "agent": "env-agent"})
            return json.loads(live.wait_job(r["job"])["reply"])
        finally:
            live.close()

    def test_agents_are_told(self):
        self.assertEqual(self.env_in(False), {"AETHER_WORKSPACE_TRUSTED": "0", "AETHER_SECRETS": str(self.key), "AETHER_AGENT": "1"})
        self.assertEqual(self.env_in(True)["AETHER_WORKSPACE_TRUSTED"], "1")


class ClaudeAdapter(unittest.TestCase):
    """The core's Claude Code adapter: untrusted → no project/local settings and no .mcp.json; the secrets denied to its tools."""

    def argv(self, trusted: str) -> list:
        d = Path(tempfile.mkdtemp())
        fake = d / "claude"
        fake.write_text(f"#!{sys.executable}\n{FAKE_CLAUDE}")
        fake.chmod(0o755)
        env = dict(os.environ, AETHER_CLAUDE=str(fake), AETHER_WORKSPACE_TRUSTED=trusted, AETHER_SECRETS="/k/key.json")
        start = {"type": "start", "prompt": "hi", "session": None, "cwd": str(d), "protect": []}
        r = subprocess.run([sys.executable, str(FALLBACK_AGENT)], input=json.dumps(start) + "\n", capture_output=True, text=True,
                           env=env, timeout=30)
        self.assertIn('"done": true', r.stdout, r.stderr)
        return json.loads((d / "claude.argv").read_text())

    def test_untrusted_flags_and_secret(self):
        a = self.argv("0")
        self.assertIn("--strict-mcp-config", a)
        self.assertEqual(a[a.index("--setting-sources") + 1], "user")
        deny = json.loads(a[a.index("--settings") + 1])["permissions"]["deny"]
        self.assertIn("Read(//k/key.json)", deny)

    def test_trusted_loads_the_workspace(self):
        a = self.argv("1")
        self.assertNotIn("--setting-sources", a)
        self.assertNotIn("--strict-mcp-config", a)


class TrustCommand(unittest.TestCase):
    def run_cli(self, *args, env=None):
        e = dict(os.environ, PYTHONPATH=str(REPO))
        e.pop("AETHER_AGENT", None)
        return subprocess.run([sys.executable, "-m", "aether", "trust", *args], capture_output=True, text=True, env={**e, **(env or {})}, timeout=30)

    def test_trust_and_remove(self):
        data, folder = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp()).resolve()
        self.assertEqual(self.run_cli(str(folder), "--data", str(data)).returncode, 0)
        self.assertEqual(json.loads((data / "config.json").read_text())["trusted"], [str(folder)])
        self.assertEqual(self.run_cli(str(folder), "--remove", "--data", str(data)).returncode, 0)
        self.assertEqual(json.loads((data / "config.json").read_text())["trusted"], [])

    def test_refused_inside_an_agent(self):
        data, folder = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        r = self.run_cli(str(folder), "--data", str(data), env={"AETHER_AGENT": "1"})
        self.assertEqual(r.returncode, 2)
        self.assertFalse((data / "config.json").exists())


class Peers(unittest.TestCase):
    def test_only_this_machine_unless_allowed(self):
        live = Live(Path(tempfile.mkdtemp()))
        try:
            core = live.srv.core
            for ok in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                self.assertTrue(core.peer_ok(ok), ok)
            self.assertFalse(core.peer_ok("192.168.1.5"))
            Path(os.environ["AETHER_SETTINGS"]).write_text(json.dumps({"allow_remote": True}))
            self.addCleanup(Path(os.environ["AETHER_SETTINGS"]).unlink)
            t = time.time() + 1
            os.utime(os.environ["AETHER_SETTINGS"], (t, t))
            self.assertTrue(core.peer_ok("192.168.1.5"))
        finally:
            live.close()


if __name__ == "__main__":
    unittest.main()
