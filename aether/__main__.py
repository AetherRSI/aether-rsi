"""python3 -m aether [--workspace DIR] [--port N] [--reload]   |   python3 -m aether check <extension folder>   |   python3 -m aether trust [DIR] [--remove]
(installed with pip, the command is `aether`). Without --workspace the core uses the folder saved from the page; a fresh install asks for it there."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import VERSION, extensions
from .server import check_workspace, serve

def default_workspace() -> str:
    """AETHER_WORKSPACE, else "" ―― the folder saved in config.json, or (a fresh install) the shell asks for one."""
    return os.environ.get("AETHER_WORKSPACE") or ""


def default_data() -> str:
    return os.environ.get("AETHER_DATA") or str(Path.home() / ".aether-rsi")


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
    if argv[:1] == ["trust"]:
        return trust(argv[1:])
    ap = argparse.ArgumentParser(prog="aether", description=f"AetherRSI {VERSION}")
    ap.add_argument("--workspace", default=default_workspace())
    ap.add_argument("--data", default=os.environ.get("AETHER_DATA") or str(Path.home() / ".aether-rsi"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AETHER_PORT") or 8030))
    ap.add_argument("--reload", action="store_true", help="swap in changed core code without a restart (after the running jobs end)")
    a = ap.parse_args(argv)
    ws = ""
    if a.workspace:
        try:
            ws = str(check_workspace(str(Path(a.workspace).expanduser().resolve())))   # a relative --workspace is from where you start
        except ValueError as e:
            print(f"{e}. Pass another --workspace, or none and set it in the page", file=sys.stderr)
            return 2
    srv = serve(ws, a.data, a.host, a.port)
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
