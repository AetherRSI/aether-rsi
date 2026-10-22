"""The file tree. Every path is relative to the workspace and must stay inside it (no '..', no absolute paths, no symlinks out)."""

from __future__ import annotations

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
    for d in deny:   # the core and the data folder, when they sit inside the workspace and the core is locked
        if p == d or d in p.parents:
            raise Outside("the core is locked")
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
