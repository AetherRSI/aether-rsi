"""Images pasted into ③ (2026-10-24 "paste images into the message box", "and leave no garbage behind").

They live in <data>/paste, never in the workspace: the explorer does not fill with screenshots and nothing an agent edits is touched.
The message quotes one as "🖼 Pasted image n" with its absolute path, so an agent can read it (the claude-code agent hands it over as an
image block). Nothing piles up:
- ✕ on the chip removes the file at once;
- every paste, every job that ends and every start sweep the folder: a file older than KEEP goes, then the oldest go while the
  folder holds more than CAP ―― except a file a running or waiting message still quotes;
- a broken upload leaves nothing (written to a hidden temp file first).
Once an agent has read an image it is in that agent's conversation, so removing the file later costs the conversation nothing.
"""

from __future__ import annotations

import os
import re
import secrets
import threading
import time
from pathlib import Path

TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
NAME = re.compile(r"^[0-9a-f]{16}\.(?:png|jpg|gif|webp)$")
MAX = 5_000_000   # one image (the shell shrinks a paste to 1568 px on its long side first, as the model would)
KEEP = 3 * 86400   # seconds a pasted image is kept unless a waiting or running message quotes it
CAP = 200_000_000   # the whole folder


class Pastes:
    def __init__(self, root: Path, in_use=lambda: ()):
        """in_use: () -> the prompts of the running and waiting jobs (a file named in one is kept)."""
        self.root, self.in_use, self.lock = Path(root), in_use, threading.Lock()

    def path(self, name: str) -> Path:
        if not NAME.match(name or ""):
            raise ValueError("not a pasted image")
        return self.root / name

    def add(self, body, size: int, ctype: str) -> dict:
        ext = TYPES.get((ctype or "").split(";")[0].strip().lower())
        if not ext:
            raise ValueError(f"a PNG, JPEG, GIF or WebP image, not {ctype or 'nothing'}")
        if not 0 < size <= MAX:
            raise ValueError(f"an image up to {MAX // 1_000_000} MB")
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.root / (secrets.token_hex(8) + ext)
        tmp = self.root / f".{p.name}.part"
        try:
            with open(tmp, "xb") as f:
                left = size
                while left > 0:
                    chunk = body.read(min(left, 1 << 20))
                    if not chunk:
                        raise ValueError("the upload stopped before its end")
                    f.write(chunk)
                    left -= len(chunk)
            tmp.replace(p)
        finally:
            tmp.unlink(missing_ok=True)
        self.sweep(keep={p.name})
        return {"name": p.name, "path": str(p)}

    def drop(self, name: str) -> bool:
        """✕ on the chip. A file a waiting or running message still quotes stays (the sweep takes it once that one has run)."""
        p = self.path(name)
        if name in self._used():
            return False
        p.unlink(missing_ok=True)
        return True

    def _used(self) -> set:
        try:
            return {m.group(0) for t in self.in_use() for m in re.finditer(r"[0-9a-f]{16}\.(?:png|jpg|gif|webp)", t or "")}
        except Exception:  # noqa: BLE001 ―― a locked store: keep everything this time rather than remove what may be quoted
            return {"*"}

    def sweep(self, now: float = None, keep=()) -> list:
        """Remove what is old (KEEP), then the oldest while over CAP, and temp files an hour old. Returns the names removed."""
        if not self.root.is_dir():
            return []
        now = time.time() if now is None else now
        with self.lock:
            used = self._used()
            if "*" in used:
                return []
            files = []
            for e in os.scandir(self.root):
                try:
                    st = e.stat()
                except OSError:
                    continue
                if e.name.endswith(".part") and now - st.st_mtime > 3600:
                    os.unlink(e.path)
                elif NAME.match(e.name):
                    files.append((st.st_mtime, st.st_size, e.name))
            files.sort()
            gone, total = [], sum(s for _, s, _ in files)
            for t, s, n in files:
                if n in used or n in keep:
                    continue
                if now - t > KEEP or total > CAP:
                    try:
                        os.unlink(self.root / n)
                    except FileNotFoundError:
                        pass
                    gone.append(n)
                    total -= s
            return gone
