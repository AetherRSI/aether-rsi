"""The repository carries no machine-specific paths. Extra words to keep out (names, companies) come from the environment
AETHER_PRIVATE_WORDS="a,b,c" so the list itself is never committed."""

import os
import re
import subprocess
import unittest

from conformance.helpers import REPO

HOME = re.compile(r"/(Users|home)/[A-Za-z0-9._-]+/")


def tracked():
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=REPO, capture_output=True, text=True, check=True).stdout
        return [REPO / f for f in out.splitlines() if (REPO / f).is_file()]
    except (OSError, subprocess.CalledProcessError):
        return [p for p in REPO.rglob("*") if p.is_file() and ".git" not in p.parts]


class Clean(unittest.TestCase):
    def test_no_home_paths_or_private_words(self):
        words = [w.strip().lower() for w in os.environ.get("AETHER_PRIVATE_WORDS", "").split(",") if w.strip()]
        hits = []
        for f in tracked():
            try:
                text = f.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if HOME.search(text):
                hits.append(f"{f.relative_to(REPO)}: home path")
            low = text.lower()
            hits += [f"{f.relative_to(REPO)}: {w}" for w in words if w in low]
        self.assertEqual(hits, [])

    def test_machine_settings_stay_local(self):
        """settings.json holds this machine's paths and project ids (where the credentials are): ignored, never committed.
        settings.example.json is the template that ships."""
        self.assertNotIn(REPO / "settings.json", tracked())
        self.assertIn("settings.json", (REPO / ".gitignore").read_text().split())
        self.assertTrue((REPO / "settings.example.json").is_file())


if __name__ == "__main__":
    unittest.main()
