"""Claude Code as an AetherRSI agent: translates the agent protocol (spec/v0.1.md §4) to `claude -p --input-format stream-json`.

- The prompt goes in through stdin, so ↪ Inject can add to the running conversation.
- One Claude session per task: the core hands back the session id it got from us last time (--resume).
- When the core is locked, writes to `protect` are denied through --settings (permissions.deny). Bash can still do anything the
  permission mode allows, so the default mode is acceptEdits (no shell without asking = no shell in -p).
Environment: AETHER_CLAUDE (path to claude) · AETHER_CLAUDE_PERMISSION (default acceptEdits) · AETHER_CLAUDE_MODEL
"""

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path


def out(**msg):
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def user(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}, ensure_ascii=False) + "\n"


def step(ev: dict) -> str:
    """One short line per tool call."""
    if ev.get("type") != "assistant":
        return ""
    for c in (ev.get("message") or {}).get("content") or []:
        if c.get("type") != "tool_use":
            continue
        name, a = c.get("name") or "", c.get("input") or {}
        if name == "Bash":
            return "💻 " + str(a.get("command") or "")[:120]
        if name == "Read":
            return "📖 " + Path(str(a.get("file_path") or "")).name
        if name in ("Edit", "Write", "NotebookEdit"):
            return "✏️ " + Path(str(a.get("file_path") or a.get("notebook_path") or "")).name
        if name in ("Grep", "Glob"):
            return "🔎 " + str(a.get("pattern") or "")[:80]
        if name == "WebFetch":
            return "🌐 " + str(a.get("url") or "")[:100]
        return f"🔧 {name}"
    return ""


def find_claude():
    """AETHER_CLAUDE if it still exists, else the PATH, else the newest copy bundled with the Claude desktop app (macOS).
    The bundled path carries the app's version, so a value set at start goes stale when the app updates."""
    exe = os.environ.get("AETHER_CLAUDE")
    if exe and os.path.exists(exe):
        return exe
    bundled = Path.home().glob("Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude")
    return shutil.which("claude") or max((str(p) for p in bundled), key=os.path.getmtime, default=None)


def main():
    start = json.loads(sys.stdin.readline())
    exe = find_claude()
    if not exe:
        out(error="claude not found: install Claude Code or set AETHER_CLAUDE")
        return
    deny = [f"{tool}(/{p}/**)" for p in start.get("protect") or [] for tool in ("Edit", "Write", "NotebookEdit")]   # "//abs/path" = absolute
    cmd = [exe, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
           "--permission-mode", os.environ.get("AETHER_CLAUDE_PERMISSION", "acceptEdits"),
           *(["--settings", json.dumps({"permissions": {"deny": deny}})] if deny else []),
           *(["--model", os.environ["AETHER_CLAUDE_MODEL"]] if os.environ.get("AETHER_CLAUDE_MODEL") else []),
           *(["--resume", start["session"]] if start.get("session") else [])]
    p = subprocess.Popen(cmd, cwd=start["cwd"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1)
    lock, state = threading.Lock(), {"open": True}

    def say(text: str) -> bool:
        with lock:
            if not state["open"]:
                return False
            try:
                p.stdin.write(user(text))
                p.stdin.flush()
                return True
            except (BrokenPipeError, OSError):
                state["open"] = False
                return False

    def injects():   # the core's stdin → Claude's stdin, until Claude has answered
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("type") == "inject" and not say(msg.get("text") or ""):
                out(step="↪ too late for this run: send it again")

    say(start["prompt"])
    threading.Thread(target=injects, daemon=True).start()
    replies, cost, failed = [], None, ""
    for line in p.stdout:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init" and ev.get("session_id"):
            out(session=ev["session_id"])
        s = step(ev)
        if s:
            out(step=s)
        if ev.get("type") == "result":   # injects sent before this are read by Claude and answered with another result
            replies.append(str(ev.get("result") or ""))
            if ev.get("total_cost_usd") is not None:
                cost = (cost or 0) + ev["total_cost_usd"]
            if ev.get("is_error"):
                failed = str(ev.get("result") or "claude reported an error")
            with lock:
                if state["open"]:
                    state["open"] = False
                    p.stdin.close()
    p.wait()
    if failed or not replies:
        out(error=failed or f"claude exited ({p.returncode}) without a result")
    else:
        out(done=True, reply="\n\n".join(r for r in replies if r), cost=cost)


if __name__ == "__main__":
    main()
