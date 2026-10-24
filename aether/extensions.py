"""Extensions: a folder with an `aether.json` manifest (spec/v0.1.md). The core only reads manifests; it never imports extension code."""

from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path

from . import PROTOCOL

MANIFEST = "aether.json"
KINDS = ("preview", "agent", "app")
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}(\.[a-z0-9][a-z0-9-]{0,39})?$")   # "name" or "author.name" (share with the author part)
ICON = {".svg": "image/svg+xml", ".png": "image/png"}   # an icon goes to the UI as a data: URL in an <img> (no route into the folder, no script runs)
ICON_MAX = 64 * 1024


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


LOOPBACK = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(/\S*)?$")


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
        bad.append("id must be lowercase letters, digits and '-' (max 40), optionally prefixed by the author: author.name")
    if not isinstance(m.get("label"), str) or not m["label"].strip():
        bad.append("label is required")
    kind = m.get("kind")
    if kind == "preview" and not _inside(folder, m.get("entry")):
        bad.append("entry must be a file inside the folder")
    if kind == "app":
        if "url" in m:   # a page served by a program on this machine (e.g. a live viewer), not a file of the folder
            if not (isinstance(m["url"], str) and LOOPBACK.match(m["url"])):
                bad.append("url must be a page of a server on this machine: http://127.0.0.1:<port>/… (or localhost)")
        elif not _inside(folder, m.get("entry")):
            bad.append("entry must be a file inside the folder (or url: a page of a server on this machine)")
    if kind == "preview":
        if "binary" in m and not isinstance(m["binary"], bool):
            bad.append("binary must be true or false")
        if "render" in m and not (isinstance(m["render"], list) and m["render"] and all(isinstance(x, str) for x in m["render"])):
            bad.append("render must be a list of strings (the command that draws the pages)")
        match = m.get("match")
        if not (isinstance(match, list) and match and all(isinstance(x, str) and (x.startswith(".") or x == "*") for x in match)):
            bad.append('match must be a list of extensions like [".md"] ("*" = any file no other preview takes)')
    if kind == "agent":
        cmd = m.get("command")
        if not (isinstance(cmd, list) and cmd and all(isinstance(x, str) for x in cmd)):
            bad.append("command must be a list of strings")
        for k in ("inject", "guard", "audio", "dispatch"):
            if k in m and not isinstance(m[k], bool):
                bad.append(f"{k} must be true or false")
    if kind == "app" and "ports" in m and not (isinstance(m["ports"], list) and all(isinstance(x, int) and not isinstance(x, bool) and 0 < x < 65536 for x in m["ports"])):
        bad.append("ports must be a list of port numbers (1-65535)")
    if kind == "app" and "agent_rules" in m and not _inside(folder, m["agent_rules"]):
        bad.append("agent_rules must be a file inside the folder")
    if "icon" in m and not (_inside(folder, m["icon"]) and Path(m["icon"]).suffix.lower() in ICON and (folder / m["icon"]).stat().st_size <= ICON_MAX):
        bad.append(f"icon must be an .svg or .png file inside the folder, up to {ICON_MAX // 1024} KB")
    return m, bad


def icon_url(m: dict) -> str:
    """The manifest's icon as a data: URL ("" without one)."""
    if not m.get("icon"):
        return ""
    f = Path(m["dir"]) / m["icon"]
    try:
        return f"data:{ICON[f.suffix.lower()]};base64,{base64.b64encode(f.read_bytes()).decode()}"
    except OSError:   # removed since the scan: the label alone
        return ""


def folders(d: Path):
    """<d>/<folder>/ and, one level down, <d>/<group>/<folder>/ (group = a folder without a manifest, e.g. preview/ or agent/)."""
    for f in sorted(p for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if (f / MANIFEST).is_file():
            yield f, None
        else:
            for g in sorted(p for p in f.iterdir() if p.is_dir() and not p.name.startswith(".")):
                yield g, f.name


def stamp(dirs) -> tuple:
    """Changes when an extension folder is added or removed, at either level, or the folder moves under a symlink, or a manifest
    or its icon is edited (the core rescans then ―― 2026-10-18 an "icon" added to claude-code's aether.json never reached the page)."""
    out = []
    for d in map(Path, dirs):
        out.append(str(d.resolve()))   # scan() keeps resolved dirs: a link swapped for its target keeps every mtime but not the path
        out.append(d.stat().st_mtime_ns if d.is_dir() else 0)
        if d.is_dir():
            out += [f.stat().st_mtime_ns for f in sorted(d.iterdir()) if f.is_dir() and not (f / MANIFEST).is_file()]
            for folder, _ in folders(d):
                out += [x.stat().st_mtime_ns if x.is_file() else 0 for x in (folder / MANIFEST, *(folder / n for n in sorted(os.listdir(folder)) if Path(n).suffix.lower() in ICON))]
    return tuple(out)


def scan(dirs, locked: bool, spare=()) -> dict:
    """Reads every extension folder (see folders). First id wins. Apps are not registered here (they live in the file tree).
    spare: folders read last that only fill in ids nobody else has (marked "spare"); one the workspace already has is skipped quietly."""
    out, seen = {"preview": {}, "agent": {}, "errors": []}, {}
    for d, is_spare in [*((d, False) for d in dirs), *((d, True) for d in spare)]:
        d = Path(d)
        if not d.is_dir():
            continue
        for folder, group in folders(d):
            m, bad = check(folder)
            if m is None and bad == [f"no {MANIFEST}"]:
                continue
            name = str(folder.relative_to(d.parent))   # projects/extensions/preview/x vs .aether-rsi/extensions/x
            if m and group in KINDS and m.get("kind") != group:
                bad = [*bad, f"kind {m.get('kind')!r} sits in the {group}/ folder"]
            if bad:
                out["errors"].append(f"{name}: {'; '.join(bad)}")
                continue
            if m["kind"] == "app":
                continue
            if m["id"] in seen:
                if not is_spare:
                    out["errors"].append(f"{name}: id {m['id']!r} is already taken by {seen[m['id']]} (rename one to author.name)")
                continue
            seen[m["id"]] = name
            m = dict(m, dir=str(folder.resolve()), **({"spare": True} if is_spare else {}))
            if m["kind"] == "agent" and locked and not m.get("guard"):
                m["disabled"] = 'the core is locked and this agent does not declare "guard": true'
            out[m["kind"]][m["id"]] = m
    return out


def app_of(folder: Path):
    """The app manifest of a folder in the file tree, or None."""
    m, bad = check(folder)
    return m if m and not bad and m["kind"] == "app" else None
