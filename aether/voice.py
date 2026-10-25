"""🎙 The person's voice to a running agent and its voice back (spec/agent.md §4.2). Standard library only: a WebSocket (RFC 6455,
server side, just what a browser sends) on the handler's own connection.

  shell ──WebSocket──▶ core ──stdin JSON lines──▶ agent     binary frame = PCM16 16 kHz  →  {"type": "audio", "data": base64}
  shell ◀──WebSocket── core ◀──stdout JSON lines── agent    {"audio": base64} → binary frame · heard / said / interrupted → text frame

A page cannot set X-Aether on a WebSocket, so the door is a ticket: POST (which needs X-Aether, so only the shell gets one) hands out a
single-use ticket for one job, valid 30 s; the GET that upgrades must carry it. One mic per job: a second connection takes over.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import socket
import struct
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TICKET_S = 30
MAX_FRAME = 1 << 20   # 1 MB: a 100 ms chunk is 3.2 KB


class Closed(Exception):
    pass


class Socket:
    """The server side of one WebSocket: rfile/wfile of the HTTP handler after the 101."""

    def __init__(self, rfile, wfile):
        self.r, self.w, self.lock, self.closed = rfile, wfile, threading.Lock(), False

    def _read(self, n: int) -> bytes:
        b = self.r.read(n)
        if len(b) < n:
            raise Closed("the shell went away")
        return b

    def recv(self):
        """(opcode, payload) of the next whole message: 1 text, 2 binary, 8 close. Pings are answered here."""
        parts, op0 = [], None
        while True:
            h = self._read(2)
            fin, op, masked, n = h[0] & 0x80, h[0] & 0x0F, h[1] & 0x80, h[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if n > MAX_FRAME or not masked:   # a browser always masks; anything else is not one
                raise Closed("bad frame")
            key = self._read(4)
            data = bytes(b ^ key[i & 3] for i, b in enumerate(self._read(n))) if n else b""
            if op == 9:
                self.send(data, 10)
                continue
            if op == 10:
                continue
            if op == 8:
                return 8, data
            if op != 0:
                op0 = op
            parts.append(data)
            if fin:
                return op0 or 2, b"".join(parts)

    def send(self, data, op: int = None):
        """str → a text frame, bytes → binary (op overrides). Raises Closed once the shell is gone."""
        if isinstance(data, str):
            data, op = data.encode(), op or 1
        op = op or 2
        n = len(data)
        head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536 else b"\x7f" + struct.pack(">Q", n))
        with self.lock:
            if self.closed:
                raise Closed("closed")
            try:
                self.w.write(head + data)
                self.w.flush()
            except (OSError, ValueError) as e:
                self.closed = True
                raise Closed(str(e)) from e

    def json(self, **msg):
        self.send(json.dumps(msg, ensure_ascii=False))

    def close(self, code: int = 1000):
        try:
            self.send(struct.pack(">H", code), 8)
        except Closed:
            pass
        self.closed = True


def accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


class Voice:
    """Tickets, and which shell listens to which job. The runner calls out() for what the agent says; the shell's frames go to
    runner.hear() / runner.mic_end()."""

    def __init__(self):
        self.tickets = {}   # ticket -> (job id, expires)
        self.ears = {}   # job id -> Socket (one mic per job)
        self.lock = threading.Lock()

    def ticket(self, jid: str) -> str:
        t = secrets.token_urlsafe(24)
        now = time.time()
        with self.lock:
            self.tickets = {k: v for k, v in self.tickets.items() if v[1] > now}
            self.tickets[t] = (jid, now + TICKET_S)
        return t

    def redeem(self, jid: str, ticket: str) -> bool:
        with self.lock:
            got = self.tickets.pop(ticket or "", None)
        return bool(got) and got[0] == jid and got[1] > time.time()

    def out(self, jid: str, ev: dict):
        """What an agent said that the shell plays or shows. Nobody listening: dropped (the steps keep heard / said)."""
        ws = self.ears.get(jid)
        if not ws:
            return
        try:
            if ev.get("audio"):
                ws.send(base64.b64decode(str(ev["audio"])))
            for k in ("heard", "said"):
                if ev.get(k):
                    ws.json(**{k: str(ev[k])})
            if ev.get("interrupted"):
                ws.json(interrupted=True)
        except (Closed, ValueError):
            pass

    def ui(self, jid: str, req: dict) -> bool:
        """🖱 An agent's screen request to the shell that holds this job's mic (spec/agent.md §4.4). False: no mic to ask."""
        ws = self.ears.get(jid)
        if not ws:
            return False
        try:
            ws.json(ui=req)
            return True
        except Closed:
            return False

    def ended(self, jid: str, state: str):
        ws = self.ears.pop(jid, None)
        if ws:
            try:
                ws.json(type="end", state=state)
            except Closed:
                pass
            ws.close()

    def serve(self, ws: Socket, jid: str, runner, store):
        """One mic, until the shell closes it, the job ends, or another mic takes over. Runs on the handler's thread."""
        with self.lock:
            old, self.ears[jid] = self.ears.get(jid), ws
        if old:
            try:
                old.json(type="end", state="taken over by another mic")
            except Closed:
                pass
            old.close()
        try:
            ready = False
            while not ready:   # queued: wait for its agent (the shell holds the mic until "ready")
                j = store.job(jid)
                if not j or j["state"] in ("done", "failed", "stopped"):
                    ws.json(type="end", state=j["state"] if j else "gone")
                    return
                if j["state"] == "running" and jid in runner.live:
                    ready = True
                    break
                ws.json(type="wait")
                time.sleep(0.3)
            ws.json(type="ready")
            while True:
                op, data = ws.recv()
                if op == 8:
                    return
                if op == 2:
                    runner.hear(jid, data)
                elif op == 1:
                    try:
                        m = json.loads(data.decode("utf-8", errors="replace"))
                    except ValueError:
                        continue
                    if isinstance(m, dict) and m.get("type") == "end":
                        runner.mic_end(jid)
                    elif isinstance(m, dict) and m.get("type") == "ui":
                        runner.ui_result(jid, m)
        except (Closed, OSError, socket.timeout):
            pass
        finally:
            with self.lock:
                if self.ears.get(jid) is ws:
                    del self.ears[jid]
            ws.close()
