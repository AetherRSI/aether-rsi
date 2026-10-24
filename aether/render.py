"""Pages a preview has drawn ahead of time (manifest `render`, spec §3.2).

A preview page runs in a sandboxed frame: it cannot start a program. Some files can only be drawn faithfully by one (a .pptx by
LibreOffice). Such a preview names a command in `render`; the core runs it as a separate process, like an agent, and keeps what it
drew under `<data>/render/<preview id>/<path hash>/<file version>/` ―― `p-1.png`, `p-2.png`… The page asks for them with `render`.

It is drawn
- when the page asks and nothing for this version of the file is there (the page shows the last version meanwhile: `stale`),
- when a job ends that quoted the file (an agent probably changed it: drawn before anyone opens it),
- again when the person presses the page's own refresh (`force`).

The command gets `<file> <out>` (an empty folder to fill), or `<file> <out> --page N --width W --base <the full render>` for one
page at a larger width (a slideshow on a large screen). Exit 0 with at least one `p-N.png` is success; anything else is kept as the
error the page shows (it may draw the file its own way instead).
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

WIDTHS = (1920, 2560, 3840)   # a page drawn larger: only these, so a page cannot make the core draw any size it likes
TIMEOUT = 300
PAGE = re.compile(r"^p-0*(\d+)\.png$")
KEY = re.compile(r"^[0-9a-f]{12}$")


def command(m: dict) -> list:
    return [a.replace("{dir}", m["dir"]).replace("{python}", sys.executable) for a in m["render"]]


def _num(p: Path) -> int:
    return int(PAGE.match(p.name).group(1))


def pages(d: Path) -> list:
    """The page images of a finished render, in page order."""
    return sorted((p for p in d.glob("p-*.png") if PAGE.match(p.name)), key=_num) if d.is_dir() else []


class Renders:
    def __init__(self, root: Path, previews, resolve, env=dict):
        """previews() -> {id: manifest}; resolve(rel) -> the workspace file (raises files.Outside); env() -> extra environment."""
        self.root, self.previews, self.resolve, self.env = Path(root), previews, resolve, env
        self.lock = threading.Lock()
        self.running = {}   # out folder -> Event (set when that render ends)
        self.errors = {}   # out folder -> what the last try said
        self.slots = threading.Semaphore(2)   # LibreOffice is heavy: at most two at once

    def _where(self, ext: str, rel: str):
        m = self.previews().get(ext)
        if not m or not m.get("render"):
            raise ValueError(f"preview {ext!r} does not draw pages")
        p = self.resolve(rel)
        if not p.is_file():
            raise FileNotFoundError(rel)
        if "*" not in m["match"] and p.suffix.lower() not in m["match"]:
            raise ValueError(f"preview {ext!r} does not open {p.suffix or 'this file'}")
        st = p.stat()
        base = self.root / ext / hashlib.sha1(rel.encode()).hexdigest()[:16]
        return m, p, base, base / hashlib.sha1(f"{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()[:12]

    def state(self, ext: str, rel: str) -> dict:
        """ready: drawn for the file as it is now · stale: only an older version is drawn (shown meanwhile) · none: nothing yet.
        running: a render of the current version is under way. error: why the last one failed."""
        _, _, base, cur = self._where(ext, rel)
        show = cur if (cur / "done").is_file() else None
        if not show and base.is_dir():
            old = [d for d in base.iterdir() if KEY.match(d.name) and (d / "done").is_file()]
            show = max(old, key=lambda d: d.stat().st_mtime_ns) if old else None
        return {"state": "none" if not show else "ready" if show == cur else "stale", "running": str(cur) in self.running,
                "error": self.errors.get(str(cur), ""), "key": show.name if show else "", "dir": str(show or ""),
                "pages": [p.name for p in pages(show)] if show else []}

    def request(self, ext: str, rel: str, force=False, wait=False, page=0, width=0) -> dict:
        m, p, base, cur = self._where(ext, rel)
        if page:
            return self._large(m, p, cur, int(page), int(width or 0))
        with self.lock:   # force keeps what is drawn until the new pages replace it: a page asked for meanwhile is still there
            busy = self.running.get(str(cur))
            if force and not busy:
                self.errors.pop(str(cur), None)
            if not busy and (force or not (cur / "done").is_file() and str(cur) not in self.errors):   # a failure is not tried again by itself: 🔄 does
                busy = self.running[str(cur)] = threading.Event()
                threading.Thread(target=self._full, args=(m, p, base, cur, busy), daemon=True).start()
        if wait and busy:
            busy.wait(TIMEOUT + 30)
        return self.state(ext, rel)

    def image(self, ext: str, rel: str, key: str, name: str) -> Path:
        """One drawn page: name is p-N.png, or wW/p-N.png for a large one."""
        _, _, base, _ = self._where(ext, rel)
        w, _, n = name.rpartition("/")
        if not KEY.match(key or "") or not PAGE.match(n) or (w and w not in {f"w{x}" for x in WIDTHS}):
            raise ValueError("no such page image")
        f = base / key / name
        if not f.is_file():
            raise FileNotFoundError(name)
        return f

    def _run(self, m: dict, args: list, tmp: Path) -> str:
        """Run the command; '' when it went well, else what it said."""
        with self.slots:
            try:
                pr = subprocess.Popen([*command(m), *args], cwd=str(tmp), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, start_new_session=True, env={**os.environ, **self.env()})
            except OSError as e:
                return f"could not start the renderer: {e}"
            try:
                out = pr.communicate(timeout=TIMEOUT)[0].decode(errors="replace")
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(pr.pid, signal.SIGKILL)   # LibreOffice starts children of its own
                except OSError:
                    pass
                pr.communicate()
                return f"the renderer took longer than {TIMEOUT} s"
        if pr.returncode:
            return (out.strip()[-400:] or f"the renderer exited ({pr.returncode})")
        return ""

    def _full(self, m, p: Path, base: Path, cur: Path, done: threading.Event):
        tmp = base / f".{cur.name}.{uuid.uuid4().hex[:8]}"
        try:
            tmp.mkdir(parents=True)
            err = self._run(m, [str(p), str(tmp)], tmp)
            if not err and not pages(tmp):
                err = "the renderer drew no page (no p-N.png)"
            if err:
                self.errors[str(cur)] = err
                return
            (tmp / "done").write_text(time.strftime("%Y-%m-%d %H:%M:%S"))
            old = base / f".{cur.name}.old.{uuid.uuid4().hex[:8]}"
            if cur.exists():
                os.replace(cur, old)   # out of the way in one step, then the new one in: no moment without pages
            os.replace(tmp, cur)
            shutil.rmtree(old, ignore_errors=True)
            for d in base.iterdir():   # only the newest version is kept
                if d != cur and KEY.match(d.name):
                    shutil.rmtree(d, ignore_errors=True)
        except Exception as e:  # noqa: BLE001 ―― a broken render must still set done, or a waiting page hangs
            self.errors[str(cur)] = repr(e)[:400]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            with self.lock:
                self.running.pop(str(cur), None)
            done.set()

    def _large(self, m, p: Path, cur: Path, n: int, w: int) -> dict:
        """One page drawn at width w (a slideshow): needs the full render first; a width not in WIDTHS gets the normal page."""
        if not (cur / "done").is_file():
            raise ValueError("draw the pages first")
        normal = {_num(x): x for x in pages(cur)}
        if n not in normal:
            raise ValueError("no such page")
        if w not in WIDTHS:
            return {"key": cur.name, "name": normal[n].name, "file": str(normal[n])}
        out = cur / f"w{w}" / f"p-{n}.png"
        with self.lock:
            busy = self.running.get(str(out))
            mine = not busy and not out.is_file()
            if mine:
                busy = self.running[str(out)] = threading.Event()
        if mine:
            tmp = cur / f".w{w}-{n}.{uuid.uuid4().hex[:8]}"
            try:
                tmp.mkdir()
                err = self._run(m, [str(p), str(tmp), "--page", str(n), "--width", str(w), "--base", str(cur)], tmp)
                got = [x for x in pages(tmp) if _num(x) == n]
                if not err and got:
                    out.parent.mkdir(exist_ok=True)
                    os.replace(got[0], out)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
                with self.lock:
                    self.running.pop(str(out), None)
                busy.set()
        elif busy:
            busy.wait(TIMEOUT + 30)
        if out.is_file():
            return {"key": cur.name, "name": f"w{w}/{out.name}", "file": str(out)}
        return {"key": cur.name, "name": normal[n].name, "file": str(normal[n])}   # could not draw it larger: the normal one
