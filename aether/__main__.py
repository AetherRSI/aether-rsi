"""python3 -m aether [--workspace DIR] [--port N] [--reload]   |   python3 -m aether check <extension folder>
(installed with pip, the command is `aether`). Without --workspace the core uses the folder saved from the page; a fresh install asks for it there."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import VERSION, extensions
from .server import check_workspace, serve

def default_workspace() -> str:
    """AETHER_WORKSPACE, else "" ―― the folder saved in config.json, or (a fresh install) the shell asks for one."""
    return os.environ.get("AETHER_WORKSPACE") or ""


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
