"""Shared bits for the conformance tests. No network beyond 127.0.0.1, no LLM."""

import atexit
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from aether import settings as _settings  # noqa: E402
from aether.server import serve_in_thread, source_checkout  # noqa: E402

_DATA = Path(os.environ.get("AETHER_DATA") or Path.home() / ".aether-rsi")
MACHINE_EXT = _settings.Settings(_settings.where(REPO, _DATA, source_checkout())).get()[0]["extensions"]   # where samples may be found
os.environ["AETHER_SETTINGS"] = str(Path(tempfile.mkdtemp(prefix="aether-settings-")) / "settings.json")   # no file: the cores under test never read this machine's settings.json


SAMPLE_PROJECT = REPO / "aether/sample_project"   # what `aether init` copies out: apps/hello-app, the sample extensions, samples/


def samples():
    """A throwaway copy of this repo's sample project (echo-agent, json-preview, apps/hello-app and the preview test files in
    samples/). Copied so the tests never write into the repo and the core stays locked. None when the checkout has none."""
    if not (SAMPLE_PROJECT / "extensions/agent/echo-agent/aether.json").is_file():
        return None
    ws = Path(tempfile.mkdtemp(prefix="aether-samples-"))
    atexit.register(shutil.rmtree, ws, True)
    shutil.copytree(SAMPLE_PROJECT, ws, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", ".*"))
    return ws


def private_extensions():
    """The extensions/ folder outside this repo that holds the non-sample extensions (gemini-argon …): AETHER_SAMPLES, else the
    workspace saved in the data folder's config.json, else the folder holding an extensions/ listed in this machine's settings.json.
    None when nothing has them."""
    try:
        saved = json.loads((_DATA / "config.json").read_text()).get("workspace")
    except (OSError, ValueError):
        saved = None
    for c in (os.environ.get("AETHER_SAMPLES"), saved, *(e.parent for e in MACHINE_EXT if e.name == "extensions")):
        if c and (Path(c) / "extensions/agent/gemini-argon/aether.json").is_file():
            return (Path(c) / "extensions").resolve()
    return None


SAMPLES = samples()
PRIVATE = private_extensions()
NO_SAMPLES = "this checkout has no aether/sample_project"
NO_PRIVATE = "no extensions/ with gemini-argon (set AETHER_SAMPLES)"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Live:
    """A core on a free port with a fresh data folder."""

    def __init__(self, workspace=None, config=None, trust=True):
        """workspace None: the samples. "": none (a fresh install). trust: the person trusts the workspace (its extensions/ run)."""
        self.data = Path(tempfile.mkdtemp())
        ws = SAMPLES if workspace is None else workspace
        conf = dict(config or {})
        if ws and trust:
            conf.setdefault("trusted", [str(ws)])
        if conf or config is not None:
            (self.data / "config.json").write_text(json.dumps(conf))
        self.port = free_port()
        self.srv = serve_in_thread(ws, self.data, port=self.port)

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
