"""Extensions: a folder with an `aether.json` manifest (spec/v0.1.md). The core only reads manifests; it never imports extension code."""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import PROTOCOL

MANIFEST = "aether.json"
KINDS = ("preview", "agent", "app")
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


def compatible(v) -> bool:
    """0.x: the minor must match exactly. From 1.0: same major, minor not newer than the core."""
    try:
        major, minor = (int(x) for x in str(v).split(".")[:2])
        cmaj, cmin = (int(x) for x in PROTOCOL.split(".")[:2])
    except ValueError:
        return False
    return (major, minor) == (cmaj, cmin) if cmaj == 0 else major == cmaj and minor <= cmin


def _inside(base: Path, rel) -> bool:
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel:
        return False
    p = (base / rel).resolve()
    return p.is_file() and base.resolve() in p.parents


def check(folder) -> tuple:
    """Returns (manifest, problems). An empty list of problems means the extension conforms to the protocol."""
    folder = Path(folder)
    f = folder / MANIFEST
    try:
        m = json.loads(f.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, [f"no {MANIFEST}"]
    except ValueError as e:
        return None, [f"{MANIFEST} is not JSON: {e}"]
    if not isinstance(m, dict):
        return None, [f"{MANIFEST} must be an object"]
    bad = []
    if not compatible(m.get("aether")):
        bad.append(f"protocol {m.get('aether')!r} is not supported (core speaks {PROTOCOL})")
    if m.get("kind") not in KINDS:
        bad.append(f"kind must be one of {', '.join(KINDS)}")
    if not ID.match(str(m.get("id") or "")):
        bad.append("id must be lowercase letters, digits and '-' (max 40)")
    if not isinstance(m.get("label"), str) or not m["label"].strip():
        bad.append("label is required")
    kind = m.get("kind")
    if kind in ("preview", "app") and not _inside(folder, m.get("entry")):
        bad.append("entry must be a file inside the folder")
    if kind == "preview":
        match = m.get("match")
        if not (isinstance(match, list) and match and all(isinstance(x, str) and x.startswith(".") for x in match)):
            bad.append('match must be a list of extensions like [".md"]')
    if kind == "agent":
        cmd = m.get("command")
        if not (isinstance(cmd, list) and cmd and all(isinstance(x, str) for x in cmd)):
            bad.append("command must be a list of strings")
        for k in ("inject", "guard"):
            if k in m and not isinstance(m[k], bool):
                bad.append(f"{k} must be true or false")
    if kind == "app" and "agent_rules" in m and not _inside(folder, m["agent_rules"]):
        bad.append("agent_rules must be a file inside the folder")
    return m, bad


def scan(dirs, locked: bool) -> dict:
    """Reads every <dir>/<folder>/aether.json. First id wins. Apps are not registered here (they live in the file tree)."""
    out = {"preview": {}, "agent": {}, "errors": []}
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for folder in sorted(p for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")):
            m, bad = check(folder)
            if m is None and bad == [f"no {MANIFEST}"]:
                continue
            name = f"{d.name}/{folder.name}"
            if bad:
                out["errors"].append(f"{name}: {'; '.join(bad)}")
                continue
            if m["kind"] == "app":
                continue
            if m["id"] in out["preview"] or m["id"] in out["agent"]:
                out["errors"].append(f"{name}: id {m['id']!r} is already taken")
                continue
            m = dict(m, dir=str(folder.resolve()))
            if m["kind"] == "agent" and locked and not m.get("guard"):
                m["disabled"] = 'the core is locked and this agent does not declare "guard": true'
            out[m["kind"]][m["id"]] = m
    return out


def app_of(folder: Path):
    """The app manifest of a folder in the file tree, or None."""
    m, bad = check(folder)
    return m if m and not bad and m["kind"] == "app" else None
