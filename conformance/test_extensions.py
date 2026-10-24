"""An extension conforms when `aether.extensions.check` finds no problems (same as `python3 -m aether check <folder>`)."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from conformance.helpers import NO_SAMPLES, SAMPLES, Live
from aether import extensions


def make(m: dict, files=("index.html",)) -> Path:
    d = Path(tempfile.mkdtemp()) / "x"
    d.mkdir()
    (d / "aether.json").write_text(json.dumps(m))
    for f in files:
        (d / f).write_text("")
    return d


OK = {"aether": "0.1", "kind": "preview", "id": "x", "label": "X", "match": [".x"], "entry": "index.html"}


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Samples(unittest.TestCase):
    def test_every_sample_conforms(self):
        folders = [*sorted((SAMPLES / "extensions").glob("*/*/aether.json")), SAMPLES / "samples/hello-app/aether.json"]
        folders = [f.parent for f in folders]
        self.assertGreaterEqual(len(folders), 6)
        for f in folders[:-1]:
            self.assertEqual(json.loads((f / "aether.json").read_text())["kind"], f.parent.name, f)   # preview/x, agent/x
        for f in folders:
            m, bad = extensions.check(f)
            self.assertEqual(bad, [], f.name)


class Rules(unittest.TestCase):
    def bad(self, m, files=("index.html",)):
        return extensions.check(make(m, files))[1]

    def test_minimal_preview(self):
        self.assertEqual(self.bad(OK), [])

    def test_protocol_version(self):
        self.assertTrue(self.bad({**OK, "aether": "0.2"}))
        self.assertTrue(self.bad({**OK, "aether": "1.0"}))
        self.assertTrue(self.bad({**OK, "aether": None}))

    def test_kind_id_label(self):
        self.assertTrue(self.bad({**OK, "kind": "plugin"}))
        self.assertTrue(self.bad({**OK, "id": "Has Space"}))
        self.assertEqual(self.bad({**OK, "id": "ada.md-preview"}), [])   # author.name
        for bad in ("ada..x", "a.b.c", ".x", "x.", "Ada.x"):
            self.assertTrue(self.bad({**OK, "id": bad}), bad)
        self.assertTrue(self.bad({**OK, "label": ""}))

    def test_entry_stays_inside(self):
        self.assertTrue(self.bad({**OK, "entry": "../index.html"}))
        self.assertTrue(self.bad({**OK, "entry": "/etc/hosts"}))
        self.assertTrue(self.bad({**OK, "entry": "missing.html"}))

    def test_preview_match(self):
        self.assertTrue(self.bad({**OK, "match": "md"}))
        self.assertTrue(self.bad({**OK, "match": ["md"]}))
        self.assertEqual(self.bad({**OK, "match": ["*"]}), [])   # fallback for types no other preview takes
        self.assertTrue(self.bad({**OK, "binary": "yes"}))
        self.assertTrue(self.bad({**OK, "match": ["md"]}))

    def test_agent(self):
        a = {"aether": "0.1", "kind": "agent", "id": "a", "label": "A", "command": ["{python}", "{dir}/a.py"], "inject": True, "guard": True}
        self.assertEqual(self.bad(a), [])
        self.assertTrue(self.bad({**a, "command": "python a.py"}))
        self.assertTrue(self.bad({**a, "inject": "yes"}))

    def test_agent_icon(self):
        """icon: an .svg / .png inside the folder; the UI gets it as a data: URL (no route into the agent's folder)."""
        a = {"aether": "0.1", "kind": "agent", "id": "a", "label": "A", "command": ["{python}", "{dir}/a.py"], "icon": "icon.svg"}
        self.assertEqual(self.bad(a, ("icon.svg",)), [])
        self.assertTrue(self.bad(a, ()))   # missing
        self.assertTrue(self.bad({**a, "icon": "../icon.svg"}, ("icon.svg",)))
        self.assertTrue(self.bad({**a, "icon": "a.py"}, ("a.py",)))   # not an image
        f = make(a, ("icon.svg",))
        (f / "icon.svg").write_text("<svg/>")
        self.assertEqual(extensions.icon_url({**a, "dir": str(f)}), "data:image/svg+xml;base64,PHN2Zy8+")
        self.assertEqual(extensions.icon_url({**a, "icon": None, "dir": str(f)}), "")
        (f / "icon.svg").write_bytes(b"x" * (extensions.ICON_MAX + 1))
        self.assertTrue(extensions.check(f)[1])   # too big

    def test_app_rules_file(self):
        a = {"aether": "0.1", "kind": "app", "id": "a", "label": "A", "entry": "index.html", "agent_rules": "CLAUDE.md"}
        self.assertTrue(self.bad(a))
        self.assertEqual(self.bad(a, ("index.html", "CLAUDE.md")), [])

    def test_app_ports(self):
        """ports: the loopback servers an app may fetch through the shell ―― a list of port numbers, nothing else."""
        a = {"aether": "0.1", "kind": "app", "id": "a", "label": "A", "entry": "index.html"}
        self.assertEqual(self.bad({**a, "ports": [8771, 8781]}, ("index.html",)), [])
        for ports in (8771, ["8771"], [0], [70000], [True], [8771.0]):
            self.assertTrue(self.bad({**a, "ports": ports}, ("index.html",)), ports)

    def test_app_served_by_a_program_on_this_machine(self):
        """An app may give url (a loopback server's page) instead of entry; nothing else, nothing outside this machine."""
        a = {"aether": "0.1", "kind": "app", "id": "live", "label": "Live"}
        for url in ("http://127.0.0.1:8770/", "http://localhost:3000/view?x=1", "http://[::1]:8080/", "https://127.0.0.1/"):
            self.assertEqual(self.bad({**a, "url": url}, ()), [], url)
        for url in ("https://example.com/", "http://10.0.0.5:8770/", "file:///etc/passwd", "javascript:alert(1)", "http://127.0.0.1.evil.com/", 8770):
            self.assertTrue(self.bad({**a, "url": url}, ()), url)
        self.assertTrue(self.bad(a, ()))   # neither entry nor url

    def test_the_tree_tells_the_shell_an_apps_url(self):
        from aether import files
        ws = Path(tempfile.mkdtemp()).resolve()   # the core hands listing a resolved workspace
        d = ws / "live"
        d.mkdir()
        (d / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "app", "id": "live", "label": "Live", "url": "http://127.0.0.1:8770/"}))
        item = next(i for i in files.listing(ws, "")["items"] if i["name"] == "live")
        self.assertEqual((item["app"]["url"], item["app"]["entry"]), ("http://127.0.0.1:8770/", ""))
        self.assertEqual(files.listing(ws, "live")["app"]["url"], "http://127.0.0.1:8770/")

    def test_locked_core_turns_off_agents_without_guard(self):
        a = make({"aether": "0.1", "kind": "agent", "id": "a", "label": "A", "command": ["x"]})
        self.assertIn("disabled", extensions.scan([a.parent], locked=True)["agent"]["a"])
        self.assertNotIn("disabled", extensions.scan([a.parent], locked=False)["agent"]["a"])

    def test_broken_extensions_are_reported_not_loaded(self):
        d = make({**OK, "aether": "9.9"})
        s = extensions.scan([d.parent], locked=True)
        self.assertEqual(s["preview"], {})
        self.assertEqual(len(s["errors"]), 1)

    def test_group_folders(self):
        """extensions/preview/<folder>/ and extensions/<any group>/<folder>/ load; a kind folder only holds that kind."""
        root = Path(tempfile.mkdtemp())
        for rel, m in (("preview/p", OK), ("ada/q", {**OK, "id": "ada.q"}), ("agent/wrong", {**OK, "id": "w"}),
                       ("flat", {**OK, "id": "flat"})):
            d = root / rel
            d.mkdir(parents=True)
            (d / "aether.json").write_text(json.dumps(m))
            (d / "index.html").write_text("")
        s = extensions.scan([root], locked=True)
        self.assertEqual(sorted(s["preview"]), ["ada.q", "flat", "x"])
        self.assertEqual(len(s["errors"]), 1)
        self.assertIn("agent/wrong", s["errors"][0])
        self.assertIn("agent/ folder", s["errors"][0])

    def test_editing_a_manifest_or_its_icon_rescans(self):
        """A manifest edited in place (an icon added to an agent) or its icon replaced changes the stamp ―― not only adding or removing folders."""
        root = Path(tempfile.mkdtemp())
        d = root / "agent" / "a"
        d.mkdir(parents=True)
        m = {"aether": "0.1", "kind": "agent", "id": "a", "label": "A", "command": ["x"]}
        (d / "aether.json").write_text(json.dumps(m))
        s0 = extensions.stamp([root])
        self.assertEqual(extensions.stamp([root]), s0)   # nothing changed
        (d / "icon.png").write_bytes(b"\x89PNG")
        s1 = extensions.stamp([root])
        self.assertNotEqual(s1, s0)
        os.utime(d / "aether.json", ns=(1, 1))   # the manifest written again (an "icon" line added)
        self.assertNotEqual(extensions.stamp([root]), s1)



AGENT = {"aether": "0.1", "kind": "agent", "id": "claude-code", "label": "Mine", "command": ["x"], "guard": True}


class Spare(unittest.TestCase):
    """aether/fallback/ fills only an id nobody else has, so a workspace without extensions/ still has claude-code (spec §2)."""

    def test_the_shipped_spares_conform(self):
        from aether.server import SPARE
        for folder in (SPARE / "agent" / "claude-code", SPARE / "preview" / "text-preview"):
            self.assertEqual(extensions.check(folder)[1], [], folder)

    def test_a_bare_workspace_still_shows_files(self):
        ws = Path(tempfile.mkdtemp())
        (ws / "note.txt").write_text("hello spare")
        bare = Live(ws)
        try:
            info = bare.json("api/info")[1]
            self.assertIn(("text-preview", True), [(p["id"], p["spare"]) for p in info["previews"]])
            code, _, body = bare.call("x/text-preview/index.html")   # its page is served from the core's folder
            self.assertEqual(code, 200)
            self.assertIn(b"<script>", body)   # aether-sdk.js inlined (bundle)
        finally:
            bare.close()

    def test_fills_only_what_is_missing(self):
        spare = make(AGENT, ()).parent
        alone = extensions.scan([Path(tempfile.mkdtemp())], locked=True, spare=[spare])
        self.assertTrue(alone["agent"]["claude-code"]["spare"])
        mine = make({**AGENT, "label": "Workspace"}, ()).parent
        both = extensions.scan([mine], locked=True, spare=[spare])
        self.assertEqual(both["agent"]["claude-code"]["label"], "Workspace")   # the workspace wins
        self.assertNotIn("spare", both["agent"]["claude-code"])
        self.assertEqual(both["errors"], [])   # and the spare it shadows is not a clash

    def test_a_workspace_without_extensions_gets_it_but_prefers_its_own(self):
        bare = Live(Path(tempfile.mkdtemp()))
        try:
            info = bare.json("api/info")[1]
            self.assertEqual([(a["id"], a["spare"]) for a in info["agents"]], [("claude-code", True)])
            self.assertEqual(info["agent"], "claude-code")
        finally:
            bare.close()
        ws = Path(tempfile.mkdtemp())
        d = ws / "extensions" / "agent" / "echo"
        d.mkdir(parents=True)
        (d / "aether.json").write_text(json.dumps({**AGENT, "id": "echo", "label": "Echo"}))
        own = Live(ws)
        try:
            self.assertEqual(own.json("api/info")[1]["agent"], "echo")   # "claude-code" sorts first, but a spare never becomes the default over the workspace's own
        finally:
            own.close()


def two_authors() -> Path:
    """A workspace with two previews for .md from different authors, plus one that copies an id."""
    ws = Path(tempfile.mkdtemp())
    for folder, pid in (("ada-md", "ada.md"), ("bob-md", "bob.md"), ("bob-md-copy", "ada.md")):
        d = ws / "extensions" / folder
        d.mkdir(parents=True)
        (d / "aether.json").write_text(json.dumps({**OK, "id": pid, "label": pid, "match": [".md"]}))
        (d / "index.html").write_text(f"<p>{pid}</p>")
    (ws / "a.md").write_text("# hi")
    return ws


class TwoAuthors(unittest.TestCase):
    """Extensions from different authors run side by side; the person decides what they would fight over (spec §2.1)."""

    def setUp(self):
        self.ws = two_authors()
        self.live = Live(self.ws)

    def tearDown(self):
        self.live.close()

    def test_both_load_and_the_copy_names_the_winner(self):
        info = self.live.json("api/info")[1]
        self.assertEqual(sorted(p["id"] for p in info["previews"] if not p["spare"]), ["ada.md", "bob.md"])   # the core's text-preview fills "*" here
        self.assertEqual(len(info["errors"]), 1)
        self.assertIn("bob-md-copy", info["errors"][0])
        self.assertIn("extensions/ada-md", info["errors"][0])
        for pid in ("ada.md", "bob.md"):
            code, _, body = self.live.call(f"x/{pid}/index.html")
            self.assertEqual(code, 200)
            self.assertIn(pid.encode(), body)

    def test_the_person_picks_who_opens_md(self):
        self.assertEqual(self.live.json("api/info")[1]["open_with"], {})
        code, r = self.live.json("api/config", {"open_with": {".md": "bob.md"}})
        self.assertEqual((code, r["open_with"]), (200, {".md": "bob.md"}))
        self.assertEqual(self.live.json("api/info")[1]["open_with"], {".md": "bob.md"})
        self.assertEqual(json.loads((self.live.data / "config.json").read_text())["open_with"], {".md": "bob.md"})
        self.assertEqual(self.live.json("api/config", {"open_with": {".md": None}})[1]["open_with"], {})

    def test_only_shared_keys_and_only_real_choices(self):
        for body in ({"core_locked": False}, {"open_with": {".md": "nobody"}}, {"open_with": {".txt": "ada.md"}},
                     {"open_with": {"md": "ada.md"}}, {"agent": "nobody"}):
            self.assertEqual(self.live.json("api/config", body)[0], 400, body)
        cfg = self.live.data / "config.json"
        self.assertEqual(json.loads(cfg.read_text()) if cfg.exists() else {}, {"trusted": [str(self.ws)]})   # nothing but what the test set up
        self.assertTrue(self.live.json("api/info")[1]["locked"])

    def test_a_fallback_can_be_picked_only_where_it_opens(self):
        d = self.ws / "extensions" / "any"
        d.mkdir()
        (d / "aether.json").write_text(json.dumps({**OK, "id": "any", "match": ["*"]}))
        (d / "index.html").write_text("")
        self.assertIn("any", [p["id"] for p in self.live.json("api/info")[1]["previews"]])
        self.assertEqual(self.live.json("api/config", {"open_with": {".log": "any"}})[0], 200)
        self.assertEqual(self.live.json("api/config", {"open_with": {".md": "any"}})[0], 400)   # .md has its own previews

    def test_pages_cannot_change_settings(self):
        code, _ = self.live.json("api/config", {"open_with": {".md": "bob.md"}}, {"Origin": "null"})
        self.assertEqual(code, 403)
        code, _, _ = self.live.call("api/config", {"open_with": {".md": "bob.md"}}, {"X-Aether": ""})
        self.assertEqual(code, 403)


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class GeminiArgon(unittest.TestCase):
    """gemini-argon/agent.py retries transient fetch failed errors with --resume and configures retryFetchErrors / ipv4first."""

    def test_settings_and_env_helpers(self):
        import importlib.util
        ag_path = SAMPLES / "extensions/agent/gemini-argon/agent.py"
        spec = importlib.util.spec_from_file_location("gemini_argon_agent", ag_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        home = Path(tempfile.mkdtemp())
        (home / ".gemini").mkdir()
        (home / ".gemini/settings.json").write_text('{"theme": "Atom One"}', encoding="utf-8")
        mod.ensure_gemini_settings(home)
        cfg = json.loads((home / ".gemini/settings.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["theme"], "Atom One")
        self.assertIs(cfg["general"]["retryFetchErrors"], True)
        env = mod.gemini_env({"NODE_OPTIONS": "--max-old-space-size=4096"})
        self.assertIn("--dns-result-order=ipv4first", env["NODE_OPTIONS"])
        self.assertIn("--max-old-space-size=4096", env["NODE_OPTIONS"])

    def test_auto_resumes_on_fetch_failed(self):
        import subprocess
        import sys
        ag_path = SAMPLES / "extensions/agent/gemini-argon/agent.py"
        tmp = Path(tempfile.mkdtemp())
        state_file = tmp / "count.txt"
        args_log = tmp / "args.jsonl"
        fake = tmp / "fake_gemini.py"
        fake.write_text(
            f"#!{sys.executable}\n"
            "import json, pathlib, sys\n"
            f"sf = pathlib.Path({str(state_file)!r})\n"
            f"af = pathlib.Path({str(args_log)!r})\n"
            "n = int(sf.read_text()) if sf.exists() else 0\n"
            "sf.write_text(str(n + 1))\n"
            "with af.open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "print(json.dumps({'type': 'init', 'session_id': 'sid-123'}), flush=True)\n"
            "if n == 0:\n"
            "    print(json.dumps({'type': 'tool_use', 'tool_name': 'read_file', 'parameters': {'file_path': 'a.md'}}), flush=True)\n"
            "    sys.stderr.write('[API Error: exception TypeError: fetch failed sending request]\\n')\n"
            "    sys.exit(1)\n"
            "print(json.dumps({'type': 'message', 'role': 'assistant', 'content': 'recovered ok'}), flush=True)\n"
            "print(json.dumps({'type': 'result', 'status': 'success', 'stats': {'total_tokens': 42}}), flush=True)\n",
            encoding="utf-8",
        )
        fake.chmod(0o755)
        env = {**os.environ, "AETHER_GEMINI": str(fake), "AETHER_GEMINI_RETRY_DELAYS": "0.01,0.02", "AETHER_BUDGET": "", "AETHER_WORKSPACE_TRUSTED": "1"}
        p = subprocess.run(
            [sys.executable, str(ag_path)],
            input=json.dumps({"prompt": "do work", "cwd": str(tmp)}) + "\n",
            capture_output=True, text=True, env=env, timeout=10,
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        events = [json.loads(line) for line in p.stdout.splitlines() if line.strip()]
        self.assertEqual([e["session"] for e in events if "session" in e], ["sid-123"])
        self.assertTrue(any(e.get("step", "").startswith("🔄 ") and "fetch failed" in e["step"] for e in events))
        done = next(e for e in events if e.get("done"))
        self.assertEqual((done["reply"], done["tokens"]), ("recovered ok", 42))
        calls = [json.loads(x) for x in args_log.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertNotIn("--resume", calls[0])
        self.assertIn("--resume", calls[1])
        self.assertEqual(calls[1][calls[1].index("--resume") + 1], "sid-123")

    def _run_fake(self, first_failure: str, start: dict):
        """A fake gemini that fails its first run with first_failure on stderr, then succeeds. → (events, argv of each run)"""
        import subprocess
        import sys
        ag_path = SAMPLES / "extensions/agent/gemini-argon/agent.py"
        tmp = Path(tempfile.mkdtemp())
        state_file, args_log, fake = tmp / "count.txt", tmp / "args.jsonl", tmp / "fake_gemini.py"
        fake.write_text(
            f"#!{sys.executable}\n"
            "import json, pathlib, sys\n"
            f"sf = pathlib.Path({str(state_file)!r})\n"
            f"af = pathlib.Path({str(args_log)!r})\n"
            "n = int(sf.read_text()) if sf.exists() else 0\n"
            "sf.write_text(str(n + 1))\n"
            "with af.open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if n == 0:\n"
            f"    sys.stderr.write({first_failure!r} + '\\n')\n"
            "    sys.exit(1)\n"
            "print(json.dumps({'type': 'init', 'session_id': 'sid-new'}), flush=True)\n"
            "print(json.dumps({'type': 'message', 'role': 'assistant', 'content': 'ok'}), flush=True)\n"
            "print(json.dumps({'type': 'result', 'status': 'success', 'stats': {'total_tokens': 1}}), flush=True)\n",
            encoding="utf-8",
        )
        fake.chmod(0o755)
        env = {**os.environ, "AETHER_GEMINI": str(fake), "AETHER_GEMINI_RETRY_DELAYS": "0.01,0.02", "AETHER_BUDGET": "", "AETHER_WORKSPACE_TRUSTED": "1"}
        p = subprocess.run([sys.executable, str(ag_path)], input=json.dumps({**start, "cwd": str(tmp)}) + "\n",
                           capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        events = [json.loads(line) for line in p.stdout.splitlines() if line.strip()]
        return events, [json.loads(x) for x in args_log.read_text().splitlines()]

    def test_retries_a_terminated_stream(self):
        events, calls = self._run_fake("[API Error: terminated]", {"prompt": "do work", "session": "sid-old"})
        self.assertTrue(any(e.get("step", "").startswith("🔄 ") and "API Error: terminated" in e["step"] for e in events))
        self.assertTrue(next(e for e in events if e.get("done")))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][calls[1].index("--resume") + 1], "sid-old")   # the same conversation goes on

    def test_a_missing_session_starts_a_new_one_with_the_rules(self):
        events, calls = self._run_fake("Error resuming session: No previous sessions found for this project.",
                                       {"prompt": "do work", "session": "sid-gone"})
        self.assertTrue(any(e.get("step", "").startswith("🆕") for e in events))
        self.assertEqual(next(e for e in events if e.get("done"))["reply"], "ok")
        self.assertEqual(len(calls), 2)
        self.assertIn("--resume", calls[0])
        self.assertNotIn("--resume", calls[1])
        prompt = calls[1][calls[1].index("-p") + 1]
        self.assertTrue(prompt.endswith("do work") and len(prompt) > len("do work"))   # the rules are back in front


if __name__ == "__main__":
    unittest.main()
