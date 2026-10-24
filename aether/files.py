"""The file tree. Every path is relative to the workspace and must stay inside it (no '..', no absolute paths, no symlinks out)."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import zipfile
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
            "ports": app.get("ports") or [], "history": app.get("history") or []}


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


MAX_ZIP = 2_000_000_000


def left_out(p: Path) -> set:
    """⬇ "without past data" on an app: what it names as its past data in aether.json "history" (runs, results, logs), as paths
    relative to it. A folder that is not an app: nothing."""
    app = app_of(p)
    return {"/".join(x for x in h.split("/") if x not in ("", ".")) for h in (app or {}).get("history") or []}


def _skip(p: Path, d: str, x: str, past: set, history: bool) -> bool:
    """Without past data (history=False): a path named in "history", or a venv (pyvenv.cfg: it holds this machine's paths and
    binaries, so it is made again where the folder goes)."""
    if history:
        return False
    r = (Path(d) / x).relative_to(p).as_posix()
    return r in past or (Path(d) / x / "pyvenv.cfg").is_file()


def zip_folder(ws: Path, rel: str, out, deny=(), history=True) -> str:
    """⬇ on a folder or an app: what the tree shows of it (HIDDEN, the locked core, secrets and links out are left out), as a zip
    written into out, each name under "<folder>/". Returns the file name to save it as: "<folder>.folder.zip".
    history=False (an app): its past data and venvs are left out (see _skip); a past-data folder stays, empty, so the app finds it."""
    p = resolve(ws, rel, deny)
    if p == ws or not p.is_dir():
        raise FileNotFoundError(rel)
    picked, total, empty, past = [], 0, [], set() if history else left_out(p)
    for d, dirs, names in os.walk(p):
        dirs[:] = sorted(x for x in dirs if x not in HIDDEN and not (Path(d) / x).is_symlink())   # a linked folder is not walked into
        for x in [x for x in dirs if _skip(p, d, x, past, history)]:
            dirs.remove(x)
            if (Path(d) / x).relative_to(p).as_posix() in past:
                empty.append(f"{p.name}/{(Path(d) / x).relative_to(p).as_posix()}/")
        for n in sorted(names):
            if n in HIDDEN or _skip(p, d, n, past, history):
                continue
            f = Path(d) / n
            try:
                real = resolve(ws, str(f.relative_to(ws)), deny)
            except Outside:
                continue
            if real.is_file():
                total += real.stat().st_size
                if total > MAX_ZIP:
                    raise ValueError(f"folder is larger than {MAX_ZIP // 1_000_000} MB")
                picked.append((real, f"{p.name}/{f.relative_to(p).as_posix()}"))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{p.name}/", "")
        for e in empty:
            z.writestr(e, "")
        for real, arc in picked:
            z.write(real, arc)
    return f"{p.name}.folder.zip"


FOLDER_ZIP = ".folder.zip"


def unzip_folder(ws: Path, rel: str, base: str, deny=()) -> str:
    """A "<name>.folder.zip" dropped on the tree (⬇ makes them): unpacked beside it into the folder base (a taken name becomes
    "base (2)", nothing is replaced), then the zip is removed. One top folder all entries share is the folder itself. Unpacked into a
    hidden temp folder first, so a broken zip leaves only itself. Absolute names and ".." are refused; links and HIDDEN are left out."""
    z_path = resolve(ws, rel, deny)
    d = resolve(ws, str(z_path.parent.relative_to(ws)), deny)
    base = base.strip() or "folder"
    if base in (".", "..") or "/" in base or "\\" in base or base in HIDDEN:
        raise ValueError("not a folder name")
    try:
        z = zipfile.ZipFile(z_path)
    except zipfile.BadZipFile:
        raise ValueError("not a zip file")
    with z:
        picked, total = [], 0
        for info in z.infolist():
            name = info.filename.replace("\\", "/") if info.create_system == 0 else info.filename   # made on Windows: "\" is its separator
            parts = [x for x in name.split("/") if x not in ("", ".")]
            if name.startswith("/") or "\x00" in name or ".." in parts or (parts and ":" in parts[0]):
                raise ValueError(f"unsafe name in the zip: {info.filename}")
            if not parts or info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000 or any(x in HIDDEN for x in parts):
                continue
            total += info.file_size
            if total > MAX_ZIP:
                raise ValueError(f"zip unpacks to more than {MAX_ZIP // 1_000_000} MB")
            picked.append((info, parts))
        if picked and len({p[0] for _, p in picked}) == 1 and all(len(p) > 1 for _, p in picked):
            picked = [(i, p[1:]) for i, p in picked]
        tmp = Path(tempfile.mkdtemp(prefix=f".{base}.", suffix=".aether-unzip", dir=d))
        try:
            for info, parts in picked:
                t = tmp.joinpath(*parts)
                t.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(t, "xb") as dst:   # "x": two entries of one name keep the first
                    left = MAX_ZIP
                    while chunk := src.read(1 << 20):
                        left -= len(chunk)
                        if left < 0:
                            raise ValueError("zip unpacks to more than it says")
                        dst.write(chunk)
            for i in range(1, 1000):
                p = d / (base if i == 1 else f"{base} ({i})")
                if not p.exists() and not p.is_symlink():
                    os.rename(tmp, p)
                    break
            else:
                raise ValueError("too many folders with this name")
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
    z_path.unlink(missing_ok=True)
    return str(p.relative_to(ws))


DEP_EXT = {".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".py", ".sh", ".json", ".toml", ".yaml", ".yml"}
_REL = re.compile(r"""(?:["'`(]|\bsrc=|\bhref=)\s*((?:\./)?\.\./[^"'`\s)<>]*)""")   # "../x", url(../x), import … from '../x'
_ABS = r"""(?:^|[\s"'`(=:,\[])((?:~|/Users|/home|/Volumes{})/[^"'`\s)<>,;\]}}]+)"""   # {}: the workspace, wherever it is
_UP = re.compile(r"""__file__\)(?:\.resolve\(\)|\.absolute\(\))?\.parents\[(\d+)\]|__file__\)(?:\.resolve\(\)|\.absolute\(\))?((?:\.parent)+)""")


def deps(ws: Path, rel: str, deny=(), limit=50, history=True) -> list:
    """⬇ on an app or an extension (a folder with aether.json): the files outside it that it points at and that exist ――
    the zip would not hold them. One per target: [{target, file, ref, more}] (file: the first file inside the folder pointing at it,
    more: how many others do). Left out: a venv inside it (pyvenv.cfg), and the machine's own settings (~/.x, ~/Library). A plain folder: [].
    history=False: what the zip without past data holds (its "history" paths are not looked into either)."""
    p = resolve(ws, rel, deny)
    if not (p / "aether.json").is_file():
        return []
    out, home, scanned, past = {}, Path.home(), 0, set() if history else left_out(p)
    absolute = re.compile(_ABS.format("|" + re.escape(str(ws))))

    def hit(f: Path, ref: str, t: Path):
        t = Path(os.path.normpath(t))
        if t == p or p in t.parents or not t.exists():
            return
        if home in t.parents and (t.relative_to(home).parts[0].startswith(".") or t.relative_to(home).parts[0] == "Library"):
            return
        key = str(t.relative_to(ws)) if ws in t.parents else str(t)
        if key in out:
            out[key]["more"] += 1
        else:
            out[key] = {"target": key, "file": f.relative_to(p).as_posix(), "ref": ref[:200], "more": 0}

    for d, dirs, names in os.walk(p):
        dirs[:] = sorted(x for x in dirs if x not in HIDDEN and not (Path(d) / x / "pyvenv.cfg").is_file() and not _skip(p, d, x, past, history))
        for n in sorted(names):
            f = Path(d) / n
            if _skip(p, d, n, past, history):
                continue
            if f.is_symlink():
                hit(f, f"link → {os.readlink(f)}", (f.parent / os.readlink(f)))
                continue
            if f.suffix.lower() not in DEP_EXT or n in HIDDEN or f.stat().st_size > 1_000_000:
                continue
            scanned += 1
            if scanned > 5000:
                return list(out.values())
            text = f.read_text(encoding="utf-8", errors="replace")
            if n == "aether.json":
                text = text.replace("{dir}/", "./")
            for m in _REL.finditer(text):
                hit(f, m.group(1), f.parent / m.group(1).split("?")[0].split("#")[0])
            for m in absolute.finditer(text):
                s = m.group(1).rstrip(".")
                hit(f, s, home / s[2:] if s.startswith("~/") else Path(s))
            if f.suffix == ".py":
                depth = len(f.relative_to(p).parts)   # parents[depth - 1] is the folder itself
                for m in _UP.finditer(text):
                    up = int(m.group(1)) + 1 if m.group(1) else m.group(2).count(".parent")
                    if up >= depth + 1:
                        hit(f, m.group(0), f.parents[up - 1] if up - 1 < len(f.parents) else Path("/"))
            if len(out) >= limit:
                return list(out.values())
    return list(out.values())
