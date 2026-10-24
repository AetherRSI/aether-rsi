"""🎙 Voice (spec §4.2): the ticket door, the WebSocket, and sound both ways through the echo agent (it plays the voice back)."""

import base64
import json
import os
import socket
import struct
import time
import unittest

from conformance.helpers import NO_SAMPLES, SAMPLES, Live
from aether import voice


class Client:
    """The browser's side of a WebSocket, just enough for the tests (frames masked, as a browser sends them)."""

    def __init__(self, port, path, origin=None):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        head = (f"GET /{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n" + (f"Origin: {origin}\r\n" if origin else "") + "\r\n")
        self.s.sendall(head.encode())
        self.f = self.s.makefile("rb")
        self.status = int(self.f.readline().split()[1])
        while self.f.readline() not in (b"\r\n", b""):
            pass
        self.ok = self.status == 101

    def send(self, data, op=None):
        if isinstance(data, str):
            data, op = data.encode(), op or 1
        op, n, mask = op or 2, len(data), os.urandom(4)
        head = bytes([0x80 | op]) + (bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack(">H", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(data)))

    def recv(self):
        h = self.f.read(2)
        if len(h) < 2:
            return None, None
        op, n = h[0] & 0x0F, h[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", self.f.read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self.f.read(8))[0]
        return op, self.f.read(n)

    def until(self, pred, limit=10):
        """Frames until pred(op, data) is true; returns what came."""
        got, end = [], time.time() + limit
        while time.time() < end:
            op, data = self.recv()
            if op is None:
                break
            got.append((op, data))
            if pred(op, data):
                return got
        raise AssertionError(f"not seen in time: {got[-5:]}")

    def close(self):
        self.s.close()


def text(op, data, **want):
    if op != 1:
        return False
    m = json.loads(data)
    return all(m.get(k) == v for k, v in want.items())


class Frames(unittest.TestCase):
    def test_accept_key(self):   # the example of RFC 6455 §1.3
        self.assertEqual(voice.accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_tickets_single_use(self):
        v = voice.Voice()
        t = v.ticket("j1")
        self.assertFalse(v.redeem("j2", t))   # another job's door: and the ticket is spent
        self.assertFalse(v.redeem("j1", t))
        t = v.ticket("j1")
        self.assertTrue(v.redeem("j1", t))
        self.assertFalse(v.redeem("j1", t))


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Mic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.live = Live()

    @classmethod
    def tearDownClass(cls):
        cls.live.close()

    def test_info_says_audio(self):
        a = {x["id"]: x for x in self.live.json("api/info")[1]["agents"]}
        self.assertTrue(a["echo-agent"]["audio"])
        self.assertFalse(a["claude-code"]["audio"])

    def test_voice_needs_an_agent_that_hears(self):
        code, r = self.live.json("api/send", {"text": "talk", "agent": "claude-code", "voice": True})
        self.assertEqual(code, 400)

    def test_door(self):
        _, r = self.live.json("api/send", {"text": "/slow no voice", "agent": "echo-agent"})
        jid = r["job"]
        self.assertEqual(self.live.call(f"api/jobs/{jid}/audio", {}, {"X-Aether": ""})[0], 403)   # the POST needs the header
        c = Client(self.live.port, f"api/jobs/{jid}/audio?ticket=made-up")
        self.assertEqual(c.status, 403)
        c.close()
        _, t = self.live.json(f"api/jobs/{jid}/audio", {})
        c = Client(self.live.port, f"api/jobs/{jid}/audio?ticket={t['ticket']}", origin="null")   # a sandboxed frame
        self.assertEqual(c.status, 403)
        c.close()
        self.live.json(f"api/jobs/{jid}/stop", {})
        self.live.wait_job(jid)
        self.assertEqual(self.live.json(f"api/jobs/{jid}/audio", {})[0], 409)   # ended: no mic any more

    def test_voice_both_ways(self):
        code, r = self.live.json("api/send", {"text": "🎙 talk", "agent": "echo-agent", "voice": True})
        self.assertEqual(code, 200)
        jid = r["job"]
        _, t = self.live.json(f"api/jobs/{jid}/audio", {})
        c = Client(self.live.port, f"api/jobs/{jid}/audio?ticket={t['ticket']}")
        self.assertTrue(c.ok)
        c.until(lambda op, d: text(op, d, type="ready"))
        pcm = struct.pack("<1600h", *range(-800, 800))   # 100 ms at 16 kHz
        for _ in range(10):
            c.send(pcm)
        got = c.until(lambda op, d: op == 2)
        back = got[-1][1]
        self.assertEqual(len(back), len(pcm) * 3 // 2)   # 24 kHz
        self.assertEqual(struct.unpack("<3h", back[:6]), (-800, -800, -799))   # 2 in → 3 out, the middle one between them
        c.send(json.dumps({"type": "end"}))
        got = c.until(lambda op, d: text(op, d, type="end"))
        heard = [json.loads(d) for op, d in got if op == 1]
        self.assertIn({"heard": "1.0 s of audio"}, heard)
        self.assertEqual(heard[-1], {"type": "end", "state": "done"})
        c.close()
        j = self.live.wait_job(jid)
        self.assertEqual(j["reply"], "Echo: heard 1.0 s of audio")
        lines = [s["text"] if isinstance(s, dict) else s for s in j.get("steps") or j.get("lines") or []]
        self.assertTrue(any(str(x).startswith("🎙 1.0 s") for x in lines), lines)
        self.assertTrue(any(str(x).startswith("🔊 That was") for x in lines), lines)

    def test_mic_waits_for_a_queued_job(self):
        _, a = self.live.json("api/send", {"text": "/slow hold the session", "agent": "echo-agent"})
        _, b = self.live.json("api/send", {"text": "🎙 next", "agent": "echo-agent", "task": a["task"]["id"], "voice": True})
        _, t = self.live.json(f"api/jobs/{b['job']}/audio", {})
        c = Client(self.live.port, f"api/jobs/{b['job']}/audio?ticket={t['ticket']}")
        c.until(lambda op, d: text(op, d, type="wait"))
        c.until(lambda op, d: text(op, d, type="ready"), limit=15)   # the slow one ended: this one runs, and hears
        c.send(json.dumps({"type": "end"}))
        c.until(lambda op, d: text(op, d, type="end", state="done"))
        c.close()

    def test_a_second_mic_takes_over(self):
        _, r = self.live.json("api/send", {"text": "🎙 two tabs", "agent": "echo-agent", "voice": True})
        jid = r["job"]
        mics = []
        for _ in range(2):
            _, t = self.live.json(f"api/jobs/{jid}/audio", {})
            mics.append(Client(self.live.port, f"api/jobs/{jid}/audio?ticket={t['ticket']}"))
            mics[-1].until(lambda op, d: text(op, d, type="ready"))
        mics[0].until(lambda op, d: text(op, d, type="end"))   # the first one hears it was taken over
        mics[1].send(json.dumps({"type": "end"}))
        mics[1].until(lambda op, d: text(op, d, type="end", state="done"))
        for m in mics:
            m.close()


DISPATCHER = r"""
import json, os, sys, urllib.request, urllib.error
start = json.loads(sys.stdin.readline())
def call(path, body, tok=os.environ.get("AETHER_TOKEN", "")):
    req = urllib.request.Request(os.environ["AETHER_API"] + path, json.dumps(body).encode(), {"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
def get(path):
    req = urllib.request.Request(os.environ["AETHER_API"] + path, headers={"Authorization": "Bearer " + os.environ.get("AETHER_TOKEN", "")})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())
me = next(q for q in get("api/queue") if q["agent"] == "dispatcher" and q["state"] == "running")
own = call("api/send", {"text": "into my own task", "agent": "echo-agent", "task": me["task"]})
got = {"child": call("api/send", {"text": "from the dispatcher", "agent": "echo-agent"}),
       "own": own, "self_inject": call("api/send", {"text": "x", "inject": me["id"]}),
       "chain": call("api/send", {"text": "to myself", "agent": "dispatcher"}),
       "voice": call("api/send", {"text": "talk", "agent": "echo-agent", "voice": True}),
       "no_token": call("api/send", {"text": "x", "agent": "echo-agent"}, tok=""),
       "bad_token": call("api/send", {"text": "x", "agent": "echo-agent"}, tok="made-up"),
       "config": call("api/config", {"agent": "echo-agent"})}
print(json.dumps({"done": True, "reply": json.dumps({k: v[0] for k, v in got.items()} | {"job": got["child"][1].get("job"), "own_job": own[1].get("job"), "me": me["task"]})}), flush=True)
"""


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Dispatch(unittest.TestCase):
    """spec §4.3: an agent with dispatch: true sends to other agents with its job's AETHER_TOKEN."""

    @classmethod
    def setUpClass(cls):
        import shutil
        import tempfile
        from pathlib import Path
        ws = Path(tempfile.mkdtemp(prefix="aether-dispatch-"))
        shutil.copytree(SAMPLES / "extensions", ws / "extensions")
        d = ws / "extensions/agent/dispatcher"
        d.mkdir()
        (d / "agent.py").write_text(DISPATCHER)
        (d / "aether.json").write_text(json.dumps({"aether": "0.1", "kind": "agent", "id": "dispatcher", "label": "Dispatcher",
                                                   "command": ["{python}", "{dir}/agent.py"], "dispatch": True, "guard": True}))
        cls.live = Live(str(ws))

    @classmethod
    def tearDownClass(cls):
        cls.live.close()

    def test_send_through_the_core(self):
        _, r = self.live.json("api/send", {"text": "hand it on", "agent": "dispatcher"})
        j = self.live.wait_job(r["job"])
        self.assertEqual(j["state"], "done", j.get("error"))
        got = json.loads(j["reply"])
        self.assertEqual(got["child"], 200)
        self.assertEqual((got["chain"], got["voice"], got["no_token"], got["bad_token"], got["config"]), (403, 403, 403, 403, 403))
        self.assertTrue(any(str(x).startswith("📨 Echo (demo): from the dispatcher") for x in j["lines"]), j["lines"])
        child = self.live.wait_job(got["job"])   # a task of its own, run by the echo agent
        self.assertEqual((child["agent"], child["state"]), ("echo-agent", "done"))
        self.assertNotEqual(child["task"], j["task"])
        self.assertEqual((got["own"], got["self_inject"]), (200, 403))   # its own task: a task of its own instead; into itself: refused
        own = self.live.wait_job(got["own_job"])
        self.assertEqual(own["state"], "done", own.get("error"))
        self.assertNotEqual(own["task"], got["me"])
        self.assertEqual(self.live.json("api/send", {"text": "y", "agent": "echo-agent"}, {"X-Aether": "", "Authorization": "Bearer x"})[0], 403)
        self.assertTrue(self.live.json("api/info")[1]["agents"][[a["id"] for a in self.live.json("api/info")[1]["agents"]].index("dispatcher")]["dispatch"])


@unittest.skipUnless(SAMPLES, NO_SAMPLES)
class Screen(unittest.TestCase):
    """spec §4.4: an agent's screen request goes to the shell over the mic's socket, and the answer back into the agent."""

    @classmethod
    def setUpClass(cls):
        cls.live = Live()

    @classmethod
    def tearDownClass(cls):
        cls.live.close()

    def test_request_and_answer(self):
        _, r = self.live.json("api/send", {"text": "🎙 /ui", "agent": "echo-agent", "voice": True})
        jid = r["job"]
        _, t = self.live.json(f"api/jobs/{jid}/audio", {})
        c = Client(self.live.port, f"api/jobs/{jid}/audio?ticket={t['ticket']}")
        got = c.until(lambda op, d: op == 1 and "ui" in json.loads(d))
        q = json.loads(got[-1][1])["ui"]
        self.assertEqual((q["id"], q["op"]), (1, "snapshot"))
        c.send(json.dumps({"type": "ui", "id": 1, "result": {"items": [{"n": 1}, {"n": 2}, {"n": 3}]}}))
        c.until(lambda op, d: text(op, d, said="screen: 3 items"))
        c.send(json.dumps({"type": "end"}))
        c.until(lambda op, d: text(op, d, type="end", state="done"))
        c.close()

    def test_no_mic_no_screen(self):
        _, r = self.live.json("api/send", {"text": "🎙 /ui", "agent": "echo-agent", "voice": True})
        jid = r["job"]
        time.sleep(1.5)   # it asked before any mic was open: the core answered for the shell
        _, t = self.live.json(f"api/jobs/{jid}/audio", {})
        c = Client(self.live.port, f"api/jobs/{jid}/audio?ticket={t['ticket']}")
        c.until(lambda op, d: text(op, d, type="ready"))
        c.send(json.dumps({"type": "end"}))
        c.until(lambda op, d: text(op, d, type="end", state="done"))
        c.close()
        lines = self.live.wait_job(jid)["lines"]
        self.assertIn("🔊 screen: no screen: the mic is not open", lines)


if __name__ == "__main__":
    unittest.main()
