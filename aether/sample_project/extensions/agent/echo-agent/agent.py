"""The smallest agent: echoes the prompt back. Shows every part of the agent protocol (spec/agent.md §4).

stdin  (from the core): {"type": "start", "prompt", "session", "cwd", "protect"}  then any number of  {"type": "inject", "text"}
stdout (to the core):   {"step": "..."}  {"session": "..."}  ...  {"done": true, "reply": "..."}   or  {"error": "..."}
Write "/slow" in the message to get a few seconds in which you can try ↪ Inject and ⏹ Stop; "/long" sends a step cut short with its whole text (full). It never writes a file, so it declares "guard": true.
🎙 Voice (spec/agent.md §4.2, "audio": true): sent from the mic, it plays the person's voice back to them (16 kHz → 24 kHz) until the mic closes,
and says how long it heard. "/ui" in the message asks the shell's screen once (spec/agent.md §4.4) and says how many items it saw.
"""

import array
import base64
import json
import select
import sys
import time
import uuid


def out(**msg):
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def up(pcm: bytes) -> bytes:
    """PCM16 16 kHz → 24 kHz (3 out for every 2 in, the middle one between them)."""
    a = array.array("h", pcm[: len(pcm) // 2 * 2])
    out = array.array("h")
    for i in range(0, len(a) - 1, 2):
        x, y = a[i], a[i + 1]
        out.extend((x, (x + y) // 2, y))
    return out.tobytes()


def voice(sid, prompt=""):
    """🎙 Until the mic closes: every chunk goes back as the agent's voice."""
    out(step="🎙 listening (your voice comes back to you)")
    if "/ui" in prompt:
        out(ui={"id": 1, "op": "snapshot"})
    heard = 0
    for line in sys.stdin:
        msg = json.loads(line)
        if msg.get("type") == "ui":
            items = (msg.get("result") or {}).get("items") or []
            out(said=f"screen: {len(items)} items" if "result" in msg else f"screen: {msg.get('error')}")
        if msg.get("type") == "audio" and msg.get("data"):
            pcm = base64.b64decode(msg["data"])
            heard += len(pcm)
            out(audio=base64.b64encode(up(pcm)).decode())
        elif msg.get("type") == "audio" and msg.get("end"):
            break
    secs = heard / 32000
    out(heard=f"{secs:.1f} s of audio")
    out(said="That was your voice, played back.")
    out(done=True, reply=f"Echo: heard {secs:.1f} s of audio", cost=0)


def main():
    start = json.loads(sys.stdin.readline())
    sid = start.get("session") or uuid.uuid4().hex
    out(session=sid)
    if start.get("audio"):
        return voice(sid, start["prompt"])
    out(step=f"📥 got {len(start['prompt'])} characters ({'continuing' if start.get('session') else 'new'} session {sid[:8]})")
    if "/long" in start["prompt"]:   # a step cut short, with its whole text (spec/agent.md §4 "full")
        out(step="📜 " + start["prompt"][:40], full="📜 " + start["prompt"])
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
