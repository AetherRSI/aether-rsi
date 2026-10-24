"""Pages a preview's own command draws (manifest `render`, spec §3.2), driven through the HTTP API with a fake renderer (no LibreOffice)."""

import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from conformance.helpers import NO_SAMPLES, SAMPLES, Live
from aether import extensions

FAKE = r'''import sys, time
from pathlib import Path
a = sys.argv[1:]
f, out = Path(a[0]), Path(a[1])
with open(Path(__file__).with_name("runs.log"), "a") as log:
    log.write(" ".join(a[2:]) + "\n")
text = f.read_text()
if "fail" in text:
    sys.exit("cannot draw this one")
if "slow" in text:
    time.sleep(1)
if "--page" in a:
    n, w = a[a.index("--page") + 1], a[a.index("--width") + 1]
    (out / f"p-{n}.png").write_bytes(f"large {w} {n}".encode())
else:
    for n in range(1, text.count("|") + 2):
        (out / f"p-{n:02d}.png").write_bytes(f"{text} page {n}".encode())
'''


def workspace() -> Path:
    ws = Path(tempfile.mkdtemp(prefix="aether-render-"))
    x = ws / "extensions/preview/fake"
    x.mkdir(parents=True)
    (x / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "preview", "id": "fake", "label": "Fake", "match": [".deck"],
                                               "binary": True, "entry": "index.html", "render": ["{python}", "{dir}/draw.py"]}))
    (x / "index.html").write_text("<p>fake</p>")
    (x / "draw.py").write_text(FAKE)
    if SAMPLES:
        shutil.copytree(SAMPLES / "extensions/agent/echo-agent", ws / "extensions/agent/echo-agent")
    return ws


class Manifest(unittest.TestCase):
    def test_render_is_a_command(self):
        d = Path(tempfile.mkdtemp())
        (d / "index.html").write_text("")
        base = {"aether": "0.1", "kind": "preview", "id": "x", "label": "X", "match": [".x"], "entry": "index.html"}
        for bad in ("render.py", [], [1], {"cmd": "x"}):
            (d / "aether.json").write_text(json.dumps(dict(base, render=bad)))
            self.assertTrue(any("render" in p for p in extensions.check(d)[1]), bad)
        (d / "aether.json").write_text(json.dumps(dict(base, render=["{python}", "{dir}/r.py"])))
        self.assertEqual(extensions.check(d)[1], [])


class Render(unittest.TestCase):
    def setUp(self):
        self.ws = workspace()
        self.live = Live(self.ws)
        self.runs = self.ws / "extensions/preview/fake/runs.log"

    def tearDown(self):
        self.live.close()
        shutil.rmtree(self.ws, ignore_errors=True)

    def ask(self, path, **kw):
        return self.live.json("api/render", {"ext": "fake", "path": path, **kw})

    def nruns(self):
        return len(self.runs.read_text().splitlines()) if self.runs.exists() else 0

    def test_drawn_once_per_version_then_stale_then_again(self):
        f = self.ws / "a.deck"
        f.write_text("one|two")
        code, r = self.ask("a.deck", wait=True)
        self.assertEqual(code, 200, r)
        self.assertEqual((r["state"], r["pages"], r["error"]), ("ready", ["p-01.png", "p-02.png"], ""))
        self.assertTrue(Path(r["dir"], "p-02.png").is_file())   # the absolute path a quote names
        code, _, raw = self.live.call(f"api/render/img?ext=fake&path=a.deck&key={r['key']}&name=p-02.png")
        self.assertEqual((code, raw), (200, b"one|two page 2"))
        self.assertEqual(self.ask("a.deck")[1]["state"], "ready")
        self.assertEqual(self.nruns(), 1, "the same version is not drawn twice")

        f.write_text("slow|changed|three")
        os.utime(f, (time.time() + 5, time.time() + 5))
        r2 = self.ask("a.deck")[1]
        self.assertEqual((r2["state"], r2["running"], r2["key"]), ("stale", True, r["key"]), "the old pages are shown while it draws")
        r3 = self.ask("a.deck", wait=True)[1]
        self.assertEqual((r3["state"], len(r3["pages"])), ("ready", 3))
        self.assertFalse(Path(r["dir"]).exists(), "only the newest version is kept")

        r4 = self.ask("a.deck", force=True, wait=True)[1]
        self.assertEqual((r4["state"], self.nruns()), ("ready", 3), "force draws again")

    def test_force_keeps_the_pages_until_the_new_ones_replace_them(self):
        (self.ws / "s.deck").write_text("slow|deck")
        r = self.ask("s.deck", wait=True)[1]
        r2 = self.ask("s.deck", force=True)[1]
        self.assertEqual((r2["state"], r2["running"]), ("ready", True))
        code, _, raw = self.live.call(f"api/render/img?ext=fake&path=s.deck&key={r['key']}&name=p-02.png")
        self.assertEqual((code, raw), (200, b"slow|deck page 2"), "a page asked for while it draws again")
        self.assertEqual(self.ask("s.deck", wait=True)[1]["running"], False)
        self.assertEqual(self.nruns(), 2)

    def test_a_failure_is_kept_and_not_retried_by_itself(self):
        (self.ws / "b.deck").write_text("fail")
        r = self.ask("b.deck", wait=True)[1]
        self.assertEqual(r["state"], "none")
        self.assertIn("cannot draw this one", r["error"])
        self.assertEqual(self.ask("b.deck", wait=True)[1]["error"], r["error"])
        self.assertEqual(self.nruns(), 1)
        self.ask("b.deck", force=True, wait=True)
        self.assertEqual(self.nruns(), 2)

    def test_one_page_larger(self):
        (self.ws / "c.deck").write_text("x|y")
        self.assertEqual(self.ask("c.deck", page=1, width=1920)[0], 400, "the full render comes first")
        self.ask("c.deck", wait=True)
        code, r = self.ask("c.deck", page=2, width=2560)
        self.assertEqual((code, r["name"]), (200, "w2560/p-2.png"))
        code, _, raw = self.live.call(f"api/render/img?ext=fake&path=c.deck&key={r['key']}&name=w2560/p-2.png")
        self.assertEqual((code, raw), (200, b"large 2560 2"))
        self.assertIn("--base", self.runs.read_text().splitlines()[-1])
        self.assertEqual(self.ask("c.deck", page=2, width=2560)[1]["name"], "w2560/p-2.png")
        self.assertEqual(self.nruns(), 2, "drawn larger once")
        self.assertEqual(self.ask("c.deck", page=1, width=777)[1]["name"], "p-01.png", "any other width: the normal page")
        self.assertEqual(self.ask("c.deck", page=9, width=1920)[0], 400)

    def test_guards(self):
        (self.ws / "d.deck").write_text("x")
        (self.ws / "e.txt").write_text("x")
        r = self.ask("d.deck", wait=True)[1]
        self.assertEqual(self.ask("e.txt")[0], 400, "a file type the preview does not open")
        self.assertEqual(self.ask("nope.deck")[0], 404)
        self.assertEqual(self.ask("../x.deck")[0], 403)
        self.assertEqual(self.live.json("api/render", {"ext": "text-preview", "path": "d.deck"})[0], 400, "a preview without render")
        for name in ("../../aether.db", "p-1.txt", "w99/p-01.png", "x/p-01.png"):
            self.assertIn(self.live.call(f"api/render/img?ext=fake&path=d.deck&key={r['key']}&name={name}")[0], (400, 404), name)
        self.assertEqual(self.live.call(f"api/render/img?ext=fake&path=d.deck&key=../../x&name=p-01.png")[0], 400)
        self.assertEqual(self.live.call("api/render", {"ext": "fake", "path": "d.deck"}, {"X-Aether": "0"})[0], 403)

    @unittest.skipUnless(SAMPLES, NO_SAMPLES)
    def test_a_job_that_quoted_the_file_draws_it_ahead(self):
        (self.ws / "q.deck").write_text("quoted|deck")
        (self.ws / "n.deck").write_text("not quoted")
        _, r = self.live.json("api/send", {"text": "fix the deck", "agent": "echo-agent", "quotes": [{"n": 1, "label": "📄 q.deck · p.2", "text": "x"}]})
        self.live.wait_job(r["job"], task=r["task"]["id"])
        end = time.time() + 10   # watch the folder: asking would draw it too
        while time.time() < end and not list((self.live.data / "render/fake").glob("*/*/done")):
            time.sleep(0.1)
        self.assertEqual(self.ask("q.deck")[1]["state"], "ready")
        self.assertEqual(self.nruns(), 1, "drawn by the job's end, not by asking")
        self.assertEqual(self.live.json("api/render", {"ext": "fake", "path": "n.deck"})[1]["state"], "none")


if __name__ == "__main__":
    unittest.main()
