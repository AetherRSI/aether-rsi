"""The smallest agent: echoes the prompt back. Shows every part of the agent protocol (spec/v0.1.md §4).

stdin  (from the core): {"type": "start", "prompt", "session", "cwd", "protect"}  then any number of  {"type": "inject", "text"}
stdout (to the core):   {"step": "..."}  {"session": "..."}  ...  {"done": true, "reply": "..."}   or  {"error": "..."}
Write "/slow" in the message to get a few seconds in which you can try ↪ Inject and ⏹ Stop. It never writes a file, so it declares "guard": true.
"""

import json
import select
import sys
import time
import uuid


def out(**msg):
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def main():
    start = json.loads(sys.stdin.readline())
    sid = start.get("session") or uuid.uuid4().hex
    out(session=sid)
    out(step=f"📥 got {len(start['prompt'])} characters ({'continuing' if start.get('session') else 'new'} session {sid[:8]})")
    injected = []
    end = time.time() + (6 if "/slow" in start["prompt"] else 0)
    while True:
        wait = end - time.time()
        if wait <= 0:
            break
        out(step=f"⏳ thinking… {int(wait) + 1}s left")
        ready, _, _ = select.select([sys.stdin], [], [], min(1, wait))
        if ready:
            line = sys.stdin.readline()
            if not line:
                break
            msg = json.loads(line)
            if msg.get("type") == "inject":
                injected.append(msg["text"])
                out(step=f"↪ heard: {msg['text'][:60]}")
    reply = "Echo: " + start["prompt"] + "".join(f"\n↪ {t}" for t in injected)
    out(done=True, reply=reply, cost=0)


if __name__ == "__main__":
    main()
