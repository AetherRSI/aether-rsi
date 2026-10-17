"""Shared bits for the conformance tests. No network beyond 127.0.0.1, no LLM."""

import json
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from aether.server import serve_in_thread  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Live:
    """A core on a free port with a fresh data folder."""

    def __init__(self, workspace=None, config=None):
        self.data = Path(tempfile.mkdtemp())
        if config is not None:
            (self.data / "config.json").write_text(json.dumps(config))
        self.port = free_port()
        self.srv = serve_in_thread(workspace or REPO / "projects", self.data, port=self.port)

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    def call(self, path, body=None, headers=None):
        h = {"Content-Type": "application/json", "X-Aether": "1"} if body is not None else {}
        h.update(headers or {})
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/{path}", json.dumps(body).encode() if body is not None else None, h)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def json(self, path, body=None, headers=None):
        code, _, raw = self.call(path, body, headers)
        return code, json.loads(raw)

    def wait_job(self, jid, states=("done", "failed", "stopped"), task=None, limit=15):
        end = time.time() + limit
        while time.time() < end:
            j = next(x for x in self.json(f"api/jobs{'?task=' + task if task else ''}")[1]["jobs"] if x["id"] == jid)
            if j["state"] in states:
                return j
            time.sleep(0.1)
        raise AssertionError(f"job {jid} stayed {j['state']}")
