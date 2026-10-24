"""python3 -m aether [--workspace DIR] [--port N] [--reload] [--no-init]   |   python3 -m aether check <extension folder>   |   python3 -m aether init [DIR]
|   python3 -m aether trust [DIR] [--remove]   |   python3 -m aether setup vertex [--project ID] [--region R] [--key FILE | --adc]
(installed with pip, the command is `aether`). Without --workspace the core uses the folder saved from the page; a fresh install asks
in the terminal whether to make a SampleProject (else the page asks for a folder)."""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import sys
from pathlib import Path

from . import VERSION, extensions
from . import settings as settings_mod
from .server import REPO, RECENT, check_workspace, serve, source_checkout

SAMPLE = Path(__file__).resolve().parent / "sample_project"   # shipped in the wheel: what `aether init` copies out


def default_workspace() -> str:
    """AETHER_WORKSPACE, else "" ―― the folder saved in config.json, or (a fresh install) the shell asks for one."""
    return os.environ.get("AETHER_WORKSPACE") or ""


def default_data() -> str:
    return os.environ.get("AETHER_DATA") or str(Path.home() / ".aether-rsi")


def saved_workspace(data) -> str:
    """config.json `workspace` ("" when none, or the file is unreadable)."""
    try:
        return json.loads((Path(data).expanduser() / "config.json").read_text()).get("workspace") or ""
    except (OSError, ValueError, AttributeError):
        return ""


def save_workspace(data, ws: Path):
    """Keep ws as the workspace for the next start, the way the page's form does (workspace + recent)."""
    d = Path(data).expanduser()
    d.mkdir(parents=True, exist_ok=True)
    cfg = d / "config.json"
    try:
        conf = json.loads(cfg.read_text()) if cfg.is_file() else {}
    except ValueError:
        conf = {}
    conf["recent"] = list(dict.fromkeys(p for p in [str(ws), conf.get("workspace") or "", *(conf.get("recent") or [])] if isinstance(p, str) and p))[:RECENT]
    conf["workspace"] = str(ws)
    tmp = cfg.with_suffix(".tmp")
    tmp.write_text(json.dumps(conf, ensure_ascii=False, indent=2))
    tmp.replace(cfg)


def set_trusted(data, folder: Path, on: bool = True) -> list:
    """config.json `trusted`: the folders whose own code the person trusts (their extensions/ may run commands; agents load their
    settings, hooks and MCP servers). Returns the list as saved."""
    d = Path(data).expanduser()
    d.mkdir(parents=True, exist_ok=True)
    cfg = d / "config.json"
    try:
        conf = json.loads(cfg.read_text()) if cfg.is_file() else {}
    except ValueError:
        conf = {}
    have = [t for t in (conf.get("trusted") or []) if isinstance(t, str) and t != str(folder)]
    conf["trusted"] = [*have, str(folder)] if on else have
    tmp = cfg.with_suffix(".tmp")
    tmp.write_text(json.dumps(conf, ensure_ascii=False, indent=2))
    tmp.replace(cfg)
    return conf["trusted"]


def trust(argv) -> int:
    ap = argparse.ArgumentParser(prog="aether trust", description="Trust a folder's own code: its extensions/ may run commands and agents "
                                 "load its settings, hooks and MCP servers. For the person: it refuses to run inside an agent's job")
    ap.add_argument("dir", nargs="?", default=".")
    ap.add_argument("--remove", action="store_true", help="stop trusting it")
    ap.add_argument("--data", default=default_data())
    a = ap.parse_args(argv)
    if os.environ.get("AETHER_AGENT") == "1":
        print("aether trust: refused inside an agent's job (only the person trusts a folder)", file=sys.stderr)
        return 2
    folder = Path(a.dir).expanduser().resolve()
    if not folder.is_dir():
        print(f"aether trust: no such folder: {folder}", file=sys.stderr)
        return 2
    now = set_trusted(a.data, folder, not a.remove)
    print(f"{'no longer trusted' if a.remove else 'trusted'}: {folder}  (trusted now: {len(now)})")
    return 0


KEY_TYPES = {"service_account", "authorized_user", "external_account", "impersonated_service_account"}


def setup(argv) -> int:
    """`aether setup vertex`: how agents reach the models, written to settings.json from a terminal (the page only shows it).
    No --key: the person's own sign-in (ADC: Cloud Shell, or `gcloud auth application-default login`), no key file anywhere."""
    ap = argparse.ArgumentParser(prog="aether setup vertex", description="Set how agents reach Vertex AI (written to settings.json). "
                                 "Without --key they use your own sign-in (ADC); refused inside an agent's job")
    ap.add_argument("what", choices=["vertex"])
    ap.add_argument("--project", help="the Google Cloud project that runs the models")
    ap.add_argument("--region", help="the Vertex AI region (default: global)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--key", help="a service-account key file, for a project your own sign-in cannot use")
    g.add_argument("--adc", action="store_true", help="drop the key file: use your own sign-in")
    ap.add_argument("--data", default=default_data())
    a = ap.parse_args(argv)
    if os.environ.get("AETHER_AGENT") == "1":
        print("aether setup: refused inside an agent's job (only the person sets how agents reach the models)", file=sys.stderr)
        return 2
    path = settings_mod.where(REPO, Path(a.data).expanduser(), source_checkout())
    try:
        raw = json.loads(path.read_text()) if path.is_file() else {}
    except ValueError as e:
        print(f"aether setup: {path} is not JSON ({e}); fix or remove it first", file=sys.stderr)
        return 2
    v = dict(raw.get("vertex") or {})
    if not (a.project or a.region or a.key or a.adc):   # no change asked: say what is set (never the key's contents)
        how = f"key file {v['credentials']}" if v.get("credentials") else ("your own sign-in (ADC)" if v.get("project") else "not set")
        print(f"settings: {path}\nvertex: project={v.get('project') or '-'}  region={v.get('region') or '-'}  sign-in={how}")
        return 0
    if a.key:
        key = Path(a.key).expanduser().resolve()
        try:
            kind = json.loads(key.read_text()).get("type")
        except (OSError, ValueError, AttributeError) as e:
            print(f"aether setup: cannot use {key} as a key file ({type(e).__name__})", file=sys.stderr)
            return 2
        if kind not in KEY_TYPES:
            print(f"aether setup: {key} is not a Google credentials file (type {kind!r})", file=sys.stderr)
            return 2
        v["credentials"] = str(key)
        ws = saved_workspace(a.data)
        if ws and (Path(ws).resolve() == key or Path(ws).resolve() in key.parents):
            print(f"note: the key sits inside the workspace {ws}. The core never shows or serves it, but outside is safer", file=sys.stderr)
    if a.adc:
        v.pop("credentials", None)
    if a.project:
        v["project"] = a.project
    v["region"] = a.region or v.get("region") or "global"
    if not v.get("project"):
        print("aether setup: --project is needed the first time", file=sys.stderr)
        return 2
    raw["vertex"] = v
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)
    print(f"saved {path}: project={v['project']} region={v['region']} sign-in={'key file' if v.get('credentials') else 'your own (ADC)'}"
          "  (a running aether reads it again by itself)")
    return 0


def make_project(where=None) -> Path:
    """Copy the SampleProject to where (default ./SampleProject). A taken name becomes name-2, name-3 …: nothing is replaced."""
    if not SAMPLE.is_dir():
        raise ValueError(f"this install has no sample project ({SAMPLE})")
    want = Path(where or "SampleProject").expanduser().resolve()
    dest, n = want, 1
    while dest.exists():
        n += 1
        dest = want.with_name(f"{want.name}-{n}")
    if not dest.parent.is_dir():
        raise ValueError(f"no such folder: {dest.parent}")
    shutil.copytree(SAMPLE, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
    return check_workspace(str(dest))   # the copy is never home or a disk root, but the rule lives in one place


def init(argv) -> int:
    ap = argparse.ArgumentParser(prog="aether init", description="Make a SampleProject (apps/hello-app and sample extensions) without asking")
    ap.add_argument("dir", nargs="?", default="SampleProject", help="where to make it (default ./SampleProject; a taken name gets -2, -3 …)")
    ap.add_argument("--data", default=default_data())
    a = ap.parse_args(argv)
    try:
        ws = make_project(a.dir)
    except (ValueError, OSError) as e:
        print(f"aether init: {e}", file=sys.stderr)
        return 2
    print(f"made {ws}")
    set_trusted(a.data, ws)   # the person asked for it and its code ships with the core
    if saved_workspace(a.data):
        print(f"start it with:  aether --workspace {ws}   (your saved workspace stays as it is)")
    else:
        save_workspace(a.data, ws)
        print("saved as the workspace. start with:  aether")
    return 0


def ask_init(data) -> str:
    """A fresh install started from a terminal: make ./SampleProject? "" = no (the page asks for a folder, as before)."""
    try:
        ans = input("AetherRSI: no workspace yet. Make a sample project at ./SampleProject? [Y/n] ").strip().lower()
    except EOFError:
        return ""
    if ans not in ("", "y", "yes"):
        return ""
    try:
        ws = make_project()
    except (ValueError, OSError) as e:
        print(f"could not make it ({e}); enter a folder in the page instead", file=sys.stderr)
        return ""
    save_workspace(data, ws)
    set_trusted(data, ws)
    print(f"made {ws} (saved as the workspace)")
    return str(ws)


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv[:1] == ["check"]:
        bad_total = 0
        for d in argv[1:] or ["."]:
            m, bad = extensions.check(d)
            print(f"{'ok ' if not bad else 'NG '} {d}" + (f"  ({m['kind']} {m['id']})" if m and not bad else ""))
            for b in bad:
                print(f"     - {b}")
            bad_total += len(bad)
        return 1 if bad_total else 0
    if argv[:1] == ["init"]:
        return init(argv[1:])
    if argv[:1] == ["trust"]:
        return trust(argv[1:])
    if argv[:1] == ["setup"]:
        return setup(argv[1:])
    ap = argparse.ArgumentParser(prog="aether", description=f"AetherRSI {VERSION}")
    ap.add_argument("--workspace", default=default_workspace())
    ap.add_argument("--data", default=default_data())
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AETHER_PORT") or 8030))
    ap.add_argument("--reload", action="store_true", help="swap in changed core code without a restart (after the running jobs end)")
    ap.add_argument("--no-init", action="store_true", help="never ask to make a sample project (the page asks for a folder)")
    a = ap.parse_args(argv)
    ws = ""
    if a.workspace:
        try:
            ws = str(check_workspace(str(Path(a.workspace).expanduser().resolve())))   # a relative --workspace is from where you start
        except ValueError as e:
            print(f"{e}. Pass another --workspace, or none and set it in the page", file=sys.stderr)
            return 2
    elif not a.no_init and not saved_workspace(a.data) and sys.stdin.isatty() and sys.stdout.isatty():
        ask_init(a.data)   # saved, not passed: the page's form stays free to change it (a passed one locks it)
    try:
        srv = serve(ws, a.data, a.host, a.port)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, errno.EACCES):
            raise
        why = "is in use (another aether, or another program: open it, or stop it)" if e.errno == errno.EADDRINUSE else "is not allowed here"
        print(f"aether: port {a.port} on {a.host} {why}. Start on another one with --port {a.port + 1}", file=sys.stderr)
        return 2
    c = srv.core
    where = c.ws or f"(not set: enter it in the page{' ― ' + c.ws_error if c.ws_error else ''})"
    print(f"AetherRSI {VERSION}  http://{a.host}:{a.port}/  workspace={where}  core {'locked 🔒' if c.locked else 'UNLOCKED 🔓'} ({c.lock_reason})", flush=True)
    for e in c.info()["errors"]:
        print(f"  extension skipped: {e}", flush=True)
    if a.reload:
        from .reload import Reloader
        Reloader(c, argv, log=lambda m: print(m, flush=True)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def cli():
    sys.exit(main())


if __name__ == "__main__":
    cli()
