"""--reload: the core swaps in its new Python code without a manual restart (the shell's html/js/css never need one: they are served no-store).

A plain "restart on save" would cut the running agents (their jobs fail with "server restarted") and could start half-written code. So:
changed → wait until the files settle → they compile and `import aether.server` passes in a child process → hand the running jobs over
(Runner.handoff: no new job starts for that moment, every reader stops between two reads, the agents' pipes become inheritable) →
exec the same command again in this process. execv keeps the pid, so the agents stay its children; the new process adopts them from
AETHER_HANDOFF and reads on. Same port; queued jobs stay in the store. Nothing waits for the running jobs to end.
While the check fails, the old code keeps serving and the reason goes to the log. aether/fallback/ is not watched: an agent is a new
process for every job, so its code is read fresh anyway.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

CORE = Path(__file__).resolve().parent
SKIP = {"__pycache__", "fallback", "sample_project"}   # sample_project: what `aether init` copies out, not core code


def stamp(root: Path = CORE) -> dict:
    out = {}
    for d, subs, files in os.walk(root):
        subs[:] = [s for s in subs if s not in SKIP]
        for f in files:
            if f.endswith(".py"):
                p = os.path.join(d, f)
                try:
                    out[p] = os.stat(p).st_mtime
                except OSError:
                    pass   # removed between the walk and the stat
    return out


def check(files) -> str:
    """'' when the changed files compile and the core imports in a fresh interpreter, else the error."""
    code = "import py_compile, sys\nfor f in sys.argv[1:]: py_compile.compile(f, doraise=True)\nimport aether.server, aether.__main__"
    r = subprocess.run([sys.executable, "-c", code, *files], cwd=str(CORE.parent), capture_output=True, text=True, timeout=60)
    return "" if r.returncode == 0 else (r.stderr.strip().splitlines() or ["exit %d" % r.returncode])[-1]


class Reloader:
    def __init__(self, core, argv, log=print, root: Path = CORE, execv=os.execv, settle: float = 1.0, every: float = 1.0):
        self.core, self.argv, self.log, self.root, self.execv, self.settle, self.every = core, list(argv), log, root, execv, settle, every
        self.base = stamp(root)

    def step(self) -> bool:
        """One look. True when it swapped (execv returns only in tests; the caller then releases the runner)."""
        now = stamp(self.root)
        if now == self.base:
            return False
        time.sleep(self.settle)   # an editor may write in several steps
        if stamp(self.root) != now:
            return False   # still being written: look again next time
        changed = sorted(p for p in now if now[p] != self.base.get(p))
        err = check(changed)
        if err:
            self.base = now
            self.log(f"[reload] kept the running code: {err}")
            return False
        runner = self.core.runner
        try:
            hand = runner.handoff()
        except TimeoutError as e:
            self.log(f"[reload] not now ({e}): trying again")
            return False   # base stays: the next look tries again
        self.base = now
        os.environ["AETHER_HANDOFF"] = json.dumps(hand)
        self.log(f"[reload] swapping in the new code ({', '.join(Path(p).name for p in changed) or 'removed files'}; {len(hand)} running job(s) handed over)")
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except (OSError, ValueError):
            pass
        try:
            self.execv(sys.executable, [sys.executable, "-m", "aether", *self.argv])
        except OSError as e:
            os.environ.pop("AETHER_HANDOFF", None)
            runner.release()
            self.log(f"[reload] could not swap: {e!r}")
            return False
        return True

    def run(self):
        while True:
            try:
                self.step()
            except Exception as e:  # noqa: BLE001 ―― the watcher must outlive one bad look
                self.log(f"[reload] {e!r}")
            time.sleep(self.every)

    def start(self):
        threading.Thread(target=self.run, daemon=True).start()
        return self
