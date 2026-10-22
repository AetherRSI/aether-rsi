"""settings.json: extension folders read whatever the workspace, and the Vertex credentials handed to agents as env."""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import Live
from aether import settings

ENV_AGENT = '''import json, os, sys
start = json.loads(sys.stdin.readline())
print(json.dumps({"done": True, "reply": json.dumps({k: os.environ.get(k) for k in start["prompt"].split()})}), flush=True)
'''


def agent_folder(root: Path, aid: str) -> Path:
    d = root / "agent" / aid
    d.mkdir(parents=True)
    (d / "agent.py").write_text(ENV_AGENT)
    (d / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "agent", "id": aid, "label": aid,
                                               "command": ["{python}", "{dir}/agent.py"], "guard": True}))
    return root


class Parse(unittest.TestCase):
    def test_vertex_becomes_env_and_env_wins(self):
        key = Path(tempfile.mkdtemp()) / "key.json"
        key.write_text("{}")
        s, bad = settings.parse({"vertex": {"credentials": str(key), "project": "p1", "region": "global"}, "env": {"CLOUD_ML_REGION": "us-east5"}})
        self.assertEqual(bad, [])
        self.assertEqual(s["env"]["GOOGLE_APPLICATION_CREDENTIALS"], str(key))
        self.assertEqual((s["env"]["ANTHROPIC_VERTEX_PROJECT_ID"], s["env"]["GOOGLE_CLOUD_PROJECT"]), ("p1", "p1"))
        self.assertEqual((s["env"]["CLAUDE_CODE_USE_VERTEX"], s["env"]["GOOGLE_GENAI_USE_VERTEXAI"]), ("1", "true"))
        self.assertEqual((s["env"]["CLOUD_ML_REGION"], s["env"]["GOOGLE_CLOUD_LOCATION"]), ("us-east5", "global"))   # env beats vertex

    def test_bad_entries_are_skipped_and_named(self):
        ok = Path(tempfile.mkdtemp())
        s, bad = settings.parse({"extensions": [str(ok), "relative/x", "/no/such/folder", 3],
                                 "vertex": {"credentials": "/no/such/key.json", "project": 1}, "env": {"A": 1}})
        self.assertEqual(s["extensions"], [ok.resolve()])
        self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", s["env"])   # a missing key file is never handed on
        self.assertEqual(len(bad), 6, bad)

    def test_no_file_is_no_settings(self):
        self.assertEqual(settings.Settings(Path(tempfile.mkdtemp()) / "settings.json").get(), ({"extensions": [], "env": {}}, []))


class InTheCore(unittest.TestCase):
    def setUp(self):
        self.was = os.environ["AETHER_SETTINGS"]
        self.file = Path(tempfile.mkdtemp()) / "settings.json"
        os.environ["AETHER_SETTINGS"] = str(self.file)
        self.shared = agent_folder(Path(tempfile.mkdtemp()), "env-agent")
        self.key = Path(tempfile.mkdtemp()) / "key.json"
        self.key.write_text("{}")

    def tearDown(self):
        os.environ["AETHER_SETTINGS"] = self.was

    def write(self, obj):
        self.file.write_text(json.dumps(obj))
        t = time.time() + 1
        os.utime(self.file, (t, t))   # a new mtime even within the same clock tick

    def test_extensions_follow_every_workspace_and_vertex_reaches_the_agent(self):
        self.write({"extensions": [str(self.shared)], "vertex": {"credentials": str(self.key), "project": "p1", "region": "global"}})
        live = Live(Path(tempfile.mkdtemp()))   # a workspace with no extensions/ of its own
        try:
            info = live.json("api/info")[1]
            self.assertEqual(info["settings"], str(self.file))
            self.assertIn("env-agent", [a["id"] for a in info["agents"]])
            _, r = live.json("api/send", {"text": "GOOGLE_APPLICATION_CREDENTIALS CLAUDE_CODE_USE_VERTEX ANTHROPIC_VERTEX_PROJECT_ID", "agent": "env-agent"})
            env = json.loads(live.wait_job(r["job"])["reply"])
            self.assertEqual(env, {"GOOGLE_APPLICATION_CREDENTIALS": str(self.key), "CLAUDE_CODE_USE_VERTEX": "1", "ANTHROPIC_VERTEX_PROJECT_ID": "p1"})
            self.write({"extensions": ["/no/such/folder"]})   # edited while running: read again, no restart
            info = live.json("api/info")[1]
            self.assertNotIn("env-agent", [a["id"] for a in info["agents"]])
            self.assertTrue(any("settings.json: extensions: no such folder" in e for e in info["errors"]), info["errors"])
        finally:
            live.close()

    def test_the_workspace_folder_listed_again_does_not_clash(self):
        ws = Path(tempfile.mkdtemp())
        agent_folder(ws / "extensions", "env-agent")
        self.write({"extensions": [str(ws / "extensions")]})
        live = Live(ws)
        try:
            info = live.json("api/info")[1]
            self.assertEqual([a["id"] for a in info["agents"] if a["id"] == "env-agent"], ["env-agent"])
            self.assertEqual(info["errors"], [])
        finally:
            live.close()

    def test_locked_core_protects_the_file(self):
        self.write({})
        live = Live(Path(tempfile.mkdtemp()))
        try:
            self.assertIn(str(self.file.resolve()), live.srv.core.runner.protect)
        finally:
            live.close()


if __name__ == "__main__":
    unittest.main()
