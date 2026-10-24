"""The file tree. Every path is relative to the workspace and must stay inside it (no '..', no absolute paths, no symlinks out)."""

from __future__ import annotations

import os
from pathlib import Path

from .extensions import app_of

HIDDEN = {".git", "__pycache__", "node_modules", ".DS_Store"}
MAX_READ = 2_000_000


class Outside(ValueError):
    pass


def resolve(ws: Path, rel: str, deny=()) -> Path:
    rel = (rel or "").strip()
    if rel.startswith("/") or "\\" in rel or "\x00" in rel:
        raise Outside("paths are relative to the workspace")
    p = (ws / rel).resolve()
    if p != ws and ws not in p.parents:
        raise Outside("outside the workspace")
    for d in deny:   # the core and the data folder (when they sit inside the workspace and the core is locked), and secrets (always)
        if p == d or d in p.parents:
            raise Outside("not shown: the locked core or a secret (the Vertex key)")
    return p


def listing(ws: Path, rel: str, deny=()) -> dict:
    p = resolve(ws, rel, deny)
    if not p.is_dir():
        raise FileNotFoundError(rel)
    items = []
    for c in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
        if c.name in HIDDEN:
            continue
        try:
            resolve(ws, str(c.relative_to(ws)), deny)
        except Outside:
            continue
        item = {"name": c.name, "path": str(c.relative_to(ws)), "dir": c.is_dir()}
        if not c.is_dir():
            item["size"] = c.stat().st_size
        else:
            app = app_of(c)
            if app:
                item["app"] = _app_ui(app)
        items.append(item)
    here = app_of(p) if p != ws else None
    return {"path": "" if p == ws else str(p.relative_to(ws)), "items": items,
            "app": _app_ui(here) if here else None}


def _app_ui(app: dict) -> dict:
    """What the shell needs of an app's manifest."""
    return {"label": app["label"], "entry": app.get("entry") or "", "url": app.get("url") or "", "rules": app.get("agent_rules") or "",
            "ports": app.get("ports") or []}


def read(ws: Path, rel: str, deny=()) -> str:
    p = resolve(ws, rel, deny)
    if not p.is_file():
        raise FileNotFoundError(rel)
    if p.stat().st_size > MAX_READ:
        raise ValueError("file is larger than 2 MB")
    return p.read_text(encoding="utf-8", errors="replace")


MAX_UPLOAD = 500_000_000


def upload(ws: Path, folder: str, name: str, body, size: int, deny=()) -> str:
    """A file dropped on the tree: written into folder (made when missing) without replacing anything ―― a name already taken
    becomes "name (2).ext". body is read in chunks into a hidden temp file first, so a broken upload leaves nothing behind."""
    if not name or name in (".", "..") or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError("a file name, without folders")
    if name in HIDDEN:
        raise ValueError(f"{name} is not shown in the tree")
    if size > MAX_UPLOAD:
        raise ValueError(f"file is larger than {MAX_UPLOAD // 1_000_000} MB")
    d = resolve(ws, folder, deny)
    d.mkdir(parents=True, exist_ok=True)
    d = resolve(ws, folder, deny)   # again: a link made meanwhile must not lead outside
    tmp = d / f".{name}.aether-upload"
    try:
        with open(tmp, "xb") as f:
            left = size
            while left > 0:
                chunk = body.read(min(left, 1 << 20))
                if not chunk:
                    raise ValueError("the upload stopped before its end")
                f.write(chunk)
                left -= len(chunk)
        stem, dot, ext = name.rpartition(".") if "." in name.lstrip(".") else (name, "", "")
        for i in range(1, 1000):
            p = d / (name if i == 1 else f"{stem} ({i}){dot}{ext}")
            try:
                os.link(tmp, p)   # fails when the name is taken: nothing is replaced, even by two drops at once
                return str(p.relative_to(ws))
            except FileExistsError:
                continue
        raise ValueError("too many files with this name")
    finally:
        tmp.unlink(missing_ok=True)
