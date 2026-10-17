"""HTTP server (standard library only). Relative URLs everywhere, so it also works under a reverse proxy prefix.

  GET  /                      the shell (static/index.html)
  GET  /api/info              name, version, lock, agents, previews, extension errors
  GET  /api/poll              {rev} ―― grows on every change; the UI refetches when it moves
  GET  /api/tasks             tasks in progress
  POST /api/tasks             {title}                         add a task
  POST /api/tasks/<id>        {title?, status?}               rename / mark done
  POST /api/send              {text, task?, agent?, quotes?, inject?}  queue a message (or inject into a running job)
  GET  /api/jobs?task=        the conversation (last 40 jobs)
  POST /api/jobs/<id>/stop    stop a queued or running job
  GET  /api/files?path=       one folder of the workspace
  GET  /api/read?path=        one text file of the workspace
  GET  /files/<path>          raw workspace file (apps run from here)
  GET  /x/<id>/<path>         raw extension file (previews run from here)
  GET  …/aether-sdk.js        the extension SDK, next to any entry

POST needs the header `X-Aether: 1` (a cross-origin page or a sandboxed frame cannot send it without a preflight we never answer).
Files under /files and /x are served with `Content-Security-Policy: sandbox allow-scripts`, so they never run with the core's origin.
A sandboxed page has an opaque origin, so behind a cookie-authenticated proxy its own requests carry no cookie and fail. The core
therefore delivers every HTML page as one document (`bundle`): relative scripts, stylesheets and images are inlined.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import PROTOCOL, VERSION, extensions, files
from .runner import Runner, compose
from .store import Store

CORE = Path(__file__).resolve().parent
STATIC = CORE / "static"


TAG = re.compile(r"<script\b[^>]*\bsrc=\"([^\"]+)\"[^>]*>\s*</script>|<link\b[^>]*>|<img\b[^>]*>", re.I)
ATTR = re.compile(r"\b(src|href|rel)=\"([^\"]*)\"", re.I)


def bundle(html: str, find) -> str:
    """Inline what a page loads from its own folder. find(url) -> Path or None (None = leave the tag as it is)."""
    def local(url):
        if not url or re.match(r"^([a-z][a-z0-9+.-]*:|//|/|#)", url, re.I):
            return None
        try:
            return find(url.split("?")[0].split("#")[0])
        except (files.Outside, ValueError):
            return None

    def swap(m):
        tag = m.group(0)
        a = {k.lower(): v for k, v in ATTR.findall(tag)}
        if tag[:7].lower() == "<script":
            p = local(a.get("src"))
            if not p:
                return tag
            head = re.sub(r"\s+src=\"[^\"]*\"", "", tag[:tag.index(">")], flags=re.I)
            code = p.read_text(encoding="utf-8", errors="replace").replace("</script", "<\\/script")
            return head + ">" + code + "</script>"
        if tag[:5].lower() == "<link":
            p = local(a.get("href")) if a.get("rel", "").lower() == "stylesheet" else None
            return f"<style>{p.read_text(encoding='utf-8', errors='replace')}</style>" if p else tag
        p = local(a.get("src"))
        if not p or p.stat().st_size > files.MAX_READ:
            return tag
        uri = f"data:{mimetypes.guess_type(p.name)[0] or 'application/octet-stream'};base64,{base64.b64encode(p.read_bytes()).decode()}"
        return tag.replace(f'src="{a["src"]}"', f'src="{uri}"', 1)

    return TAG.sub(swap, html)


class Core:
    def __init__(self, workspace, data):
        self.ws = Path(workspace).expanduser().resolve()
        self.data = Path(data).expanduser().resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        cfg = self.data / "config.json"
        self.config = json.loads(cfg.read_text()) if cfg.is_file() else {}
        self.locked = self.config.get("core_locked", True) is not False
        self.protect = [CORE, self.data] if self.locked else []
        self.store = Store(self.data / "aether.db")
        self._ext, self._ext_at = None, None
        self.runner = Runner(self.store, lambda: self.ext()["agent"], self.ws, self.protect, self.data / "logs")

    def ext(self) -> dict:
        """Rescanned when an extensions folder changes (git clone / rm -rf, then reload the page)."""
        dirs = [self.ws / "extensions", self.data / "extensions"]
        stamp = tuple(os.stat(d).st_mtime_ns if d.is_dir() else 0 for d in dirs)
        if stamp != self._ext_at:
            self._ext, self._ext_at = extensions.scan(dirs, self.locked), stamp
        return self._ext

    def default_agent(self) -> str:
        agents = {k: a for k, a in self.ext()["agent"].items() if not a.get("disabled")}
        want = self.config.get("agent")
        return want if want in agents else (sorted(agents)[0] if agents else "")

    def info(self) -> dict:
        e = self.ext()
        return {"name": "AetherRSI", "version": VERSION, "protocol": PROTOCOL, "locked": self.locked, "workspace": self.ws.name,
                "agent": self.default_agent(),
                "agents": [{"id": a["id"], "label": a["label"], "inject": bool(a.get("inject")), "disabled": a.get("disabled", "")}
                           for a in e["agent"].values()],
                "previews": [{"id": p["id"], "label": p["label"], "match": p["match"], "entry": p["entry"]} for p in e["preview"].values()],
                "errors": e["errors"]}

    def send(self, b: dict) -> dict:
        text = str(b.get("text") or "").strip()
        if not text:
            raise ValueError("nothing to send")
        if b.get("inject"):
            j = self.store.job(str(b["inject"]))
            if not j:
                raise ValueError("no such job to inject into")
            if self.runner.inject(j["id"], text):
                return {"injected": True, "job": j["id"]}
            nj = self.store.add_job(j["task"], text, text, j["agent"], first=True)   # too late: next in the same conversation
            self.runner.wake.set()
            return {"injected": False, "job": nj["id"], "note": "the job had ended; queued next in the same conversation"}
        agent = str(b.get("agent") or "") or self.default_agent()
        a = self.ext()["agent"].get(agent)
        if not a:
            raise ValueError(f"no agent {agent!r}")
        if a.get("disabled"):
            raise ValueError(a["disabled"])
        task = self.store.task(str(b.get("task") or ""))
        if b.get("task") and not task:
            raise ValueError("no such task")
        task = task or self.store.add_task(text.splitlines()[0])
        j = self.store.add_job(task["id"], text, compose(text, b.get("quotes")), agent)
        self.runner.wake.set()
        return {"job": j["id"], "task": task}


def handler(core: Core):
    class H(BaseHTTPRequestHandler):
        server_version = "AetherRSI"

        def log_message(self, *a):
            pass

        def _send(self, code: int, body: bytes, ctype: str, sandbox: bool = False):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if sandbox:
                self.send_header("Content-Security-Policy", "sandbox allow-scripts")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code: int = 200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def _file(self, p: Path, sandbox: bool, root: Path = None, deny=()):
            """root: inline what an HTML page loads from inside root (see bundle)."""
            if not p.is_file():
                return self._json({"error": "not found"}, 404)
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            body = p.read_bytes()
            if root is not None and ctype == "text/html":
                def near(url):
                    q = (p.parent / url).resolve()
                    if not q.is_file() and q.name == "aether-sdk.js":
                        return STATIC / "aether-sdk.js"
                    inside = (q == root or root in q.parents) and not any(q == d or d in q.parents for d in deny)
                    return q if inside and q.is_file() else None
                body = bundle(body.decode("utf-8", errors="replace"), near).encode()
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self._send(200, body, ctype, sandbox)

        def do_GET(self):
            u = urlparse(self.path)
            path, q = unquote(u.path), {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if path.endswith("/aether-sdk.js") and (path.startswith("/x/") or path.startswith("/files/")):
                    return self._file(STATIC / "aether-sdk.js", False)
                if path == "/":
                    return self._file(STATIC / "index.html", False)
                if path.startswith("/static/"):
                    return self._file(files.resolve(STATIC, path[len("/static/"):]), False)
                if path.startswith("/files/"):
                    return self._file(files.resolve(core.ws, path[len("/files/"):], core.protect), True, core.ws, core.protect)
                if path.startswith("/x/"):
                    xid, _, rest = path[3:].partition("/")
                    p = core.ext()["preview"].get(xid)
                    if not p:
                        return self._json({"error": "no such extension"}, 404)
                    return self._file(files.resolve(Path(p["dir"]), rest), True, Path(p["dir"]))
                if path == "/api/info":
                    return self._json(core.info())
                if path == "/api/poll":
                    return self._json({"rev": core.store.rev()})
                if path == "/api/tasks":
                    return self._json(core.store.tasks())
                if path == "/api/jobs":
                    jobs = core.store.jobs(q.get("task") or None)
                    for j in jobs:
                        if j["state"] == "queued":
                            j["pos"] = core.store.queued_before(j["id"]) + 1
                    return self._json({"jobs": jobs, "task": core.store.task(q.get("task") or "")})
                if path == "/api/files":
                    return self._json(files.listing(core.ws, q.get("path", ""), core.protect))
                if path == "/api/read":
                    return self._json({"path": q.get("path", ""), "text": files.read(core.ws, q.get("path", ""), core.protect)})
                return self._json({"error": "not found"}, 404)
            except files.Outside as e:
                return self._json({"error": str(e)}, 403)
            except FileNotFoundError:
                return self._json({"error": "not found"}, 404)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)

        def do_POST(self):
            if self.headers.get("X-Aether") != "1" or self.headers.get("Origin") == "null":
                return self._json({"error": "forbidden"}, 403)
            path = urlparse(self.path).path
            try:
                n = int(self.headers.get("Content-Length") or 0)
                b = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if not isinstance(b, dict):
                    raise ValueError("body must be an object")
                if path == "/api/send":
                    return self._json(core.send(b))
                if path == "/api/tasks":
                    return self._json(core.store.add_task(str(b.get("title") or "")))
                if path.startswith("/api/tasks/"):
                    tid = path.rsplit("/", 1)[1]
                    if not core.store.task(tid):
                        return self._json({"error": "no such task"}, 404)
                    return self._json(core.store.update_task(tid, b.get("title"), b.get("status")))
                if path.startswith("/api/jobs/") and path.endswith("/stop"):
                    return self._json({"state": core.runner.stop(path.split("/")[3])})
                return self._json({"error": "not found"}, 404)
            except LookupError as e:
                return self._json({"error": str(e)}, 404)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)

    return H


def serve(workspace, data, host="127.0.0.1", port=8030, worker=True):
    core = Core(workspace, data)
    if worker:
        core.runner.start()
    srv = ThreadingHTTPServer((host, port), handler(core))
    srv.daemon_threads = True
    srv.core = core
    return srv


def serve_in_thread(*a, **kw):
    srv = serve(*a, **kw)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
