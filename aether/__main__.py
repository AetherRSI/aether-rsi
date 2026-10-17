"""python3 -m aether [--workspace DIR] [--port N]   |   python3 -m aether check <extension folder>"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import VERSION, extensions
from .server import serve

REPO = Path(__file__).resolve().parents[1]


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
    ap.add_argument("--workspace", default=os.environ.get("AETHER_WORKSPACE") or str(REPO / "projects"))
    ap.add_argument("--data", default=os.environ.get("AETHER_DATA") or str(Path.home() / ".aether-rsi"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AETHER_PORT") or 8030))
    a = ap.parse_args(argv)
    srv = serve(a.workspace, a.data, a.host, a.port)
    c = srv.core
    print(f"AetherRSI {VERSION}  http://{a.host}:{a.port}/  workspace={c.ws}  core {'locked 🔒' if c.locked else 'UNLOCKED 🔓'}", flush=True)
    for e in c.info()["errors"]:
        print(f"  extension skipped: {e}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
