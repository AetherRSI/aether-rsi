"""What goes to PyPI: the built wheel and sdist in AETHER_DIST (a folder, e.g. dist/ after `python -m build`).
Opt-in, since building needs the network. They carry the sample project and the fallbacks, depend on nothing,
and hold no machine settings, secrets, caches or home paths (the words of test_clean)."""

import os
import re
import tarfile
import unittest
import zipfile
from pathlib import Path

from aether import VERSION
from conformance.test_clean import HOME

DIST = os.environ.get("AETHER_DIST")
NEEDED = ("aether/sample_project/apps/hello-app/aether.json", "aether/sample_project/extensions/agent/echo-agent/aether.json",
          "aether/fallback/agent/claude-code/aether.json", "aether/fallback/preview/text-preview/aether.json", "aether/static/")
NEVER = re.compile(r"(^|/)(settings\.json|\.env|[^/]*\.db|__pycache__|[^/]*\.pyc|\.DS_Store|credentials[^/]*\.json)(/|$)")


def members(path: Path) -> dict:
    """{name inside the archive: bytes}. The sdist's top folder (aether_rsi-X.Y.Z/) is cut so both read alike."""
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as z:
            return {n: z.read(n) for n in z.namelist() if not n.endswith("/")}
    with tarfile.open(path) as t:
        return {m.name.split("/", 1)[1]: t.extractfile(m).read() for m in t.getmembers() if m.isfile() and "/" in m.name}


@unittest.skipUnless(DIST, "set AETHER_DIST=<folder with the built .whl and .tar.gz>")
class Dist(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d = Path(DIST)
        cls.wheels, cls.sdists = sorted(d.glob("*.whl")), sorted(d.glob("*.tar.gz"))

    def test_one_of_each_at_this_version(self):
        self.assertEqual([p.name for p in self.wheels], [f"aether_rsi-{VERSION}-py3-none-any.whl"])
        self.assertEqual([p.name for p in self.sdists], [f"aether_rsi-{VERSION}.tar.gz"])

    def test_sample_project_and_fallbacks_ship(self):
        for p in self.wheels + self.sdists:
            names = members(p)
            for need in NEEDED:
                self.assertTrue(any(n.startswith(need) for n in names), f"{p.name}: no {need}")

    def test_depends_on_nothing(self):
        for p in self.wheels:
            meta = next(v for n, v in members(p).items() if n.endswith(".dist-info/METADATA")).decode()
            self.assertNotIn("Requires-Dist:", meta)
            self.assertIn(f"Version: {VERSION}", meta)

    def test_nothing_private(self):
        words = [w.strip().lower() for w in os.environ.get("AETHER_PRIVATE_WORDS", "").split(",") if w.strip()]
        hits = []
        for p in self.wheels + self.sdists:
            for name, data in members(p).items():
                if NEVER.search(name):
                    hits.append(f"{p.name}: {name}")
                    continue
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    continue
                if HOME.search(text):
                    hits.append(f"{p.name}: {name}: home path")
                low = text.lower()
                hits += [f"{p.name}: {name}: {w}" for w in words if w in low]
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
