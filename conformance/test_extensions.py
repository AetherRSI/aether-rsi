"""An extension conforms when `aether.extensions.check` finds no problems (same as `python3 -m aether check <folder>`)."""

import json
import tempfile
import unittest
from pathlib import Path

from conformance.helpers import REPO
from aether import extensions


def make(m: dict, files=("index.html",)) -> Path:
    d = Path(tempfile.mkdtemp()) / "x"
    d.mkdir()
    (d / "aether.json").write_text(json.dumps(m))
    for f in files:
        (d / f).write_text("")
    return d


OK = {"aether": "0.1", "kind": "preview", "id": "x", "label": "X", "match": [".x"], "entry": "index.html"}


class Samples(unittest.TestCase):
    def test_every_sample_conforms(self):
        folders = [*sorted((REPO / "projects/extensions").iterdir()), REPO / "projects/hello-app"]
        self.assertGreaterEqual(len(folders), 4)
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
        self.assertTrue(self.bad({**OK, "label": ""}))

    def test_entry_stays_inside(self):
        self.assertTrue(self.bad({**OK, "entry": "../index.html"}))
        self.assertTrue(self.bad({**OK, "entry": "/etc/hosts"}))
        self.assertTrue(self.bad({**OK, "entry": "missing.html"}))

    def test_preview_match(self):
        self.assertTrue(self.bad({**OK, "match": "md"}))
        self.assertTrue(self.bad({**OK, "match": ["md"]}))

    def test_agent(self):
        a = {"aether": "0.1", "kind": "agent", "id": "a", "label": "A", "command": ["{python}", "{dir}/a.py"], "inject": True, "guard": True}
        self.assertEqual(self.bad(a), [])
        self.assertTrue(self.bad({**a, "command": "python a.py"}))
        self.assertTrue(self.bad({**a, "inject": "yes"}))

    def test_app_rules_file(self):
        a = {"aether": "0.1", "kind": "app", "id": "a", "label": "A", "entry": "index.html", "agent_rules": "CLAUDE.md"}
        self.assertTrue(self.bad(a))
        self.assertEqual(self.bad(a, ("index.html", "CLAUDE.md")), [])

    def test_locked_core_turns_off_agents_without_guard(self):
        a = make({"aether": "0.1", "kind": "agent", "id": "a", "label": "A", "command": ["x"]})
        self.assertIn("disabled", extensions.scan([a.parent], locked=True)["agent"]["a"])
        self.assertNotIn("disabled", extensions.scan([a.parent], locked=False)["agent"]["a"])

    def test_broken_extensions_are_reported_not_loaded(self):
        d = make({**OK, "aether": "9.9"})
        s = extensions.scan([d.parent], locked=True)
        self.assertEqual(s["preview"], {})
        self.assertEqual(len(s["errors"]), 1)


if __name__ == "__main__":
    unittest.main()
