"""HTTP server (standard library only). Relative URLs everywhere, so it also works under a reverse proxy prefix.

  GET  /                      the shell (static/index.html)
  GET  /api/info              name, version, lock, workspace and the recent ones, settings file, agents (icon: a data: URL or ""), previews, extension and settings errors
  GET  /api/poll              {rev, reloading} ―― rev grows on every change; the UI refetches when it moves. reloading: --reload holds the queue to swap in new code
  GET  /api/tasks?all=1       tasks in progress (all=1: done ones too), each with the state of its latest job
  POST /api/tasks             {title, ref?}                   add a task (ref: where an app keeps it, e.g. "app/sessions/12#n3"; the shell bundles by session)
  POST /api/tasks/<id>        {title?, status?, ref?}         rename / mark done / point at a session
  POST /api/send              {text, task?, agent?, quotes?, inject?, first?, parallel?, ref?, confirm?}  queue a message (first: next in line; parallel: ⚡ if the task's
                              session is busy, it becomes a new task of its own and starts now; ref: for a new task) or inject into a running job
                              {text, quotes?, append|edit: <job id>, confirm?}  add to (append) or rewrite (edit) a message that still waits in the queue
                              409 {error, conflict: [{job, task, title, paths}]}: another session's running job is editing a file or folder it quotes ―― the person approves, then it is sent again with confirm: true
  GET  /api/jobs?task=        the conversation (last 40 jobs)
  GET  /api/queue             what runs and waits (running first, then queued with pos = place in its session), each with its task's title, ref and quotes [{n, label}]; text is the first line, full all of it (≤ 2,000)
  POST /api/jobs/<id>/stop    stop a queued or running job
  POST /api/jobs/<id>/move    {before?}  a queued job moves just before another queued job of its session (before: its id), or last (none) ―― the order it runs in
                              (409 once it, or one it passes, runs or ended; 400 when before is not one of its session's queued jobs)
  POST /api/jobs/<id>/audio   → {ticket}: 🎙 single use, 30 s, for GET /api/jobs/<id>/audio?ticket= (Upgrade: websocket) ―― the person's voice to the
                              job's agent and its voice back (manifest audio: true, spec §4.2; POST /api/send voice: true starts a job for it)
  POST /api/jobs/<id>/parallel  {confirm?}  ⚡ a queued job leaves its busy session for a new task of its own and starts now (409 once it runs or ended; 409 conflict as for send)
  POST /api/config            {agent?, open_with?, workspace?}  the person's choices (shared keys only; core_locked is not one)
  GET  /api/files?path=       one folder of the workspace (409 until a workspace is set)
  GET  /api/read?path=        one text file of the workspace
  POST /api/upload?path=&name=  the raw body becomes a file of the workspace folder path (made when missing; a taken name becomes "name (2).ext") → {path}
  POST /api/paste             the raw body (Content-Type image/png|jpeg|gif|webp) is an image pasted into ③, kept outside the workspace (paste.py) → {name, path}
  GET  /api/paste/<name>      that image (the chip's thumbnail) · POST /api/paste/<name>/drop  ✕ on its chip → {dropped} (false while a message quotes it)
  POST /api/render            {ext, path, force?, wait?, page?, width?}  pages a preview draws (manifest render, see render.py) → {state, running, error, key, dir, pages}
                              (page + width: that page drawn larger → {key, name, file}). wait: answer when the render ends
  GET  /api/render/img?ext=&path=&key=&name=  one drawn page (name p-N.png or wW/p-N.png)
  GET  /files/<path>          raw workspace file (apps run from here)
  GET  /x/<id>/<path>         raw extension file (previews run from here)
  GET  …/aether-sdk.js        the extension SDK, next to any entry
  GET  …/aether-icons.js      the shell's Material icons (mui("Name"), muiLead, muiText), next to any entry

POST needs the header `X-Aether: 1` (a cross-origin page or a sandboxed frame cannot send it without a preflight we never answer).
Files under /files and /x are served with `Content-Security-Policy: sandbox allow-scripts allow-modals` (modals: print), so they never run with the core's origin.
A sandboxed page has an opaque origin, so behind a cookie-authenticated proxy its own requests carry no cookie and fail. The core
therefore delivers every HTML page as one document (`bundle`): relative scripts, stylesheets and images are inlined.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import ipaddress
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import PROTOCOL, VERSION, extensions, files, paste, render, settings, voice
from .runner import Runner, append, compose, quotes_of
from .store import Store, session_of

CORE = Path(__file__).resolve().parent
STATIC = CORE / "static"
PAGE_SHARED = {"aether-sdk.js": "aether-sdk.js", "aether-icons.js": "icons.js"}   # what any page may load from beside its entry (2026-10-24: the icons too, so a preview draws the same one-colour icons)
SPARE = CORE / "fallback"   # extensions shipped with the core (claude-code, text-preview), used only for an id no other folder has
REPO = CORE.parent


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


SHARED = ("agent", "open_with", "workspace")   # keys the shell may write. Extensions never write them (spec §2.1)
RECENT = 10   # config `recent`: the workspaces used last, newest first. The core writes it when the workspace changes; the shell only reads it


class Started(Exception):
    """The message to edit has left the queue (it runs or ended): nothing was changed (409)."""


class Forbidden(Exception):
    """An agent's dispatch the core refuses (spec §4.3): 403."""


DISPATCH_MAX = 20   # sends per job (spec §4.3)


class Conflict(Exception):
    """Another session's running job is editing what this message quotes: nothing was sent until the person approves (409, confirm: true)."""

    def __init__(self, hits: list):
        self.hits = hits
        super().__init__("another task is editing " + ", ".join(p for h in hits for p in h["paths"]) + " right now: approve to send anyway")


SRC = re.compile(r"^(?:📄|📁|🧩) (.+?)/?(?: · .*)?$")   # a quote of the file tree: "📄 a/b.md · Intro", "📁 a/", "🧩 app/"


def paths_of(prompt: str) -> set:
    """The workspace files and folders a message quotes (what it may change)."""
    return {m.group(1).strip("/") for q in quotes_of(prompt) if (m := SRC.match(q["label"]))}


def overlap(a: str, b: str) -> bool:
    """The same file, or one inside the other ("" is the whole workspace)."""
    return a == b or not a or not b or a.startswith(b + "/") or b.startswith(a + "/")


class NoWorkspace(LookupError):
    """Started with no workspace (a fresh install): the shell asks for one before the file tree and agents work."""


def check_workspace(path) -> Path:
    """A folder the person may hand to agents: it exists, and it is not the home folder or a disk root (agents could touch everything)."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("enter the path of a folder")
    p = Path(path.strip()).expanduser()
    if not p.is_absolute():
        raise ValueError("use an absolute path (or ~/…)")
    p = p.resolve()
    if not p.is_dir():
        raise ValueError(f"no such folder: {p}")
    if p in (Path.home().resolve(), Path(p.anchor)):
        raise ValueError(f"refusing {p} as the workspace (agents could touch everything). Pick a project folder")
    return p


def source_checkout(repo: Path = REPO) -> bool:
    """A git clone of aether-rsi (spec/ and conformance/ beside the package), not a pip install in site-packages."""
    return (repo / "spec").is_dir() and (repo / "conformance").is_dir() and not {"site-packages", "dist-packages"} & set(repo.parts)


def lock_state(setting, ws, repo: Path = REPO):
    """(locked, reason). Opening a folder that holds the core's own clone is how the person says \"I am working on the core\"."""
    if setting is False:
        return False, "config.json: core_locked is false"
    if setting is True:
        return True, "config.json: core_locked is true"
    if ws and (ws == repo or ws in repo.parents):
        if source_checkout(repo):
            return False, f"the workspace contains the core ({repo.name})"
        return True, "the core here is an installed package (open a git clone to edit it)"
    return True, "the core is outside the workspace" if ws else "no workspace yet"


class Core:
    def __init__(self, workspace, data):
        """workspace: the --workspace flag or AETHER_WORKSPACE (fixed for this run), else config.json `workspace`, else None (the shell asks)."""
        self.data = Path(data).expanduser().resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        self.cfg = self.data / "config.json"
        self.config = json.loads(self.cfg.read_text()) if self.cfg.is_file() else {}
        self.fixed = bool(workspace)
        self.ws, self.ws_error = None, ""
        try:
            want = workspace or self.config.get("workspace")
            self.ws = check_workspace(str(want)) if want else None
        except ValueError as e:
            if self.fixed:
                raise
            self.ws_error = f"the saved workspace is not usable: {e}"   # moved or deleted: ask again instead of failing to start
        self.store = Store(self.data / "aether.db")
        self.settings = settings.Settings(settings.where(REPO, self.data, source_checkout()))
        self._ext, self._ext_at = None, None
        self.runner = Runner(self.store, lambda: self.ext()["agent"], self.ws, [], self.data / "logs")
        self.runner.env = self.agent_env
        self.renders = render.Renders(self.data / "render", lambda: self.ext()["preview"], lambda rel: files.resolve(self.need_ws(), rel, self.protect),
                                      lambda: self.settings.get()[0]["env"])
        self.runner.after = self.drawn_ahead
        self.voice = voice.Voice()   # 🎙 the shell's mic ⇄ an agent with audio: true (spec §4.2)
        self.runner.voice_out, self.runner.voice_end = self.voice.out, self.voice.ended
        self.runner.voice_ui = self.voice.ui
        self.pastes = paste.Pastes(self.data / "paste", lambda: [j["prompt"] for j in self.store.queue()])
        self.pastes.sweep()
        self.relock()

    def relock(self):
        """Locked unless the person unlocked it: config `core_locked` (true or false wins), else a workspace that contains this clone of the core."""
        self.locked, self.lock_reason = lock_state(self.config.get("core_locked"), self.ws)
        self.protect = [CORE, self.data, self.settings.path.resolve()] if self.locked else []   # settings.json sits beside the core: an agent must not repoint the credentials
        self.runner.protect = [str(p) for p in self.protect]
        self._ext_at = None   # agents without guard are enabled only while unlocked

    def ext(self) -> dict:
        """Rescanned when an extensions folder changes (git clone / rm -rf, then reload the page)."""
        s, bad = self.settings.get()
        dirs = ([self.ws / "extensions"] if self.ws else []) + s["extensions"] + [self.data / "extensions"]   # settings.json extensions: always, whatever the workspace
        seen = set()   # one folder twice (the workspace's own extensions/ is also in settings) would clash with itself: keep the first
        dirs = [d for d in dirs if not (str(d.resolve()) in seen or seen.add(str(d.resolve())))]
        trusted, ws_ext = self.trusted(), (self.ws / "extensions").resolve() if self.ws else None
        stamp = (extensions.stamp([*dirs, SPARE]), tuple(bad), trusted)
        if stamp != self._ext_at:
            ext = extensions.scan(dirs, self.locked, [SPARE])
            if ws_ext and not trusted:   # an untrusted workspace's own extensions/ may not run commands, nor take the id of a trusted one
                safe = extensions.scan([d for d in dirs if d.resolve() != ws_ext], self.locked, [SPARE])
                for kind in ("agent", "preview"):
                    for k, m in list(ext[kind].items()):
                        if Path(m["dir"]).is_relative_to(ws_ext) and (kind == "agent" or m.get("render")):
                            ext["errors"].append(f"{k}: not run ― the workspace is not trusted to run its own commands (trust it with: aether trust {self.ws})")
                            if k in safe[kind]:
                                ext[kind][k] = safe[kind][k]
                            else:
                                del ext[kind][k]
            self._ext, self._ext_at = ext, stamp
            self._ext["errors"] = [*bad, *self._ext["errors"]]
        return self._ext

    def trusted(self) -> bool:
        """Whether the person trusts the workspace's own code. config.json `trusted` lists folders (a workspace inside one counts), added
        by the person with `aether trust <folder>` or `aether init`. Untrusted: the workspace's extensions/ may not run commands (agents,
        render) and agents start without its settings, hooks and MCP servers (they would run before anyone looks)."""
        if not self.ws:
            return False
        try:
            listed = json.loads(self.cfg.read_text()).get("trusted") if self.cfg.is_file() else None
        except (OSError, ValueError, AttributeError):
            listed = None
        for t in listed if isinstance(listed, list) else []:
            try:
                p = Path(str(t)).expanduser().resolve()
            except (OSError, RuntimeError):
                continue
            if self.ws == p or p in self.ws.parents:
                return True
        return False

    def agent_env(self) -> dict:
        """settings.json env, plus what an agent must know: AETHER_WORKSPACE_TRUSTED ("1" only when the person trusts the workspace: an
        adapter may then load its settings, hooks and MCP servers), AETHER_SECRETS (files its own tools must not read: the Vertex key,
        os.pathsep-joined) and AETHER_AGENT=1 (`aether trust` refuses to run under it)."""
        env = dict(self.settings.get()[0]["env"])
        secrets = [env["GOOGLE_APPLICATION_CREDENTIALS"]] if env.get("GOOGLE_APPLICATION_CREDENTIALS") else []
        return {**env, "AETHER_WORKSPACE_TRUSTED": "1" if self.trusted() else "0", "AETHER_SECRETS": os.pathsep.join(secrets), "AETHER_AGENT": "1"}

    def peer_ok(self, addr) -> bool:
        """Only this machine reaches the core (a proxy in front runs on it too), unless settings.json allow_remote is true."""
        try:
            a = ipaddress.ip_address(str(addr).split("%")[0])
            if (a.ipv4_mapped if a.version == 6 and a.ipv4_mapped else a).is_loopback:
                return True
        except ValueError:
            pass
        return bool(self.settings.get()[0].get("allow_remote"))

    def default_agent(self) -> str:
        agents = {k: a for k, a in self.ext()["agent"].items() if not a.get("disabled")}
        want = self.config.get("agent")
        return want if want in agents else (min(agents, key=lambda k: (bool(agents[k].get("spare")), k)) if agents else "")   # the workspace's own agents before a spare

    def drawn_ahead(self, jid: str):
        """A job ended: the files it quoted that their preview draws (manifest `render`) are drawn now, before anyone opens them ――
        the agent probably changed them. Only what is not drawn for the file as it is now. And the pasted images nothing needs any more go."""
        try:
            self.pastes.sweep()
        except OSError:
            pass
        j = self.store.job(jid)
        if not j or not self.ws:
            return
        previews, ow = self.ext()["preview"], self.config.get("open_with") or {}
        for rel in paths_of(j["prompt"]):
            x = Path(rel).suffix.lower()
            pid = ow[x] if ow.get(x) in previews else next((k for k, p in previews.items() if x in p["match"]), None)
            if pid and previews[pid].get("render"):
                try:
                    self.renders.request(pid, rel)
                except (ValueError, OSError):   # a folder, gone, outside the workspace: nothing to draw
                    pass

    def host_ok(self, host, origin) -> bool:
        """DNS rebinding: a page of another site whose name now resolves to 127.0.0.1 sends that name as Host (and Origin), and
        X-Aether no longer stops it (it is same-origin to the browser). Only names nobody can rebind pass ―― an IP address,
        localhost ―― and the ones settings.json `hosts` / AETHER_HOSTS add for a proxy in front."""
        extra = set(self.settings.get()[0].get("hosts", [])) | {h.strip().lower() for h in os.environ.get("AETHER_HOSTS", "").split(",") if h.strip()}
        web = os.environ.get("WEB_HOST", "").strip().lower()   # Google Cloud Shell: its web preview is https://<port>-$WEB_HOST (the proxy rewrites Host, not Origin)
        return all(allowed_host(n, extra) or bool(web and n.endswith("-" + web)) for n in (hostname(host), hostname(origin, url=True)) if n is not None)

    def need_ws(self) -> Path:
        if not self.ws:
            raise NoWorkspace("no workspace yet: set the folder in the shell first")
        return self.ws

    def info(self) -> dict:
        e = self.ext()
        return {"name": "AetherRSI", "version": VERSION, "protocol": PROTOCOL, "locked": self.locked, "lock_reason": self.lock_reason,
                "workspace": self.ws.name if self.ws else "", "workspace_path": str(self.ws or ""),
                "workspace_fixed": self.fixed, "workspace_error": self.ws_error,
                "settings": str(self.settings.path) if self.settings.path.is_file() else "",
                "recent": [p for p in self.config.get("recent") or [] if isinstance(p, str) and Path(p).is_dir()],   # moved or deleted ones drop out of the list, not out of the file
                "agent": self.default_agent(),
                "agents": [{"id": a["id"], "label": a["label"], "icon": extensions.icon_url(a), "inject": bool(a.get("inject")), "audio": bool(a.get("audio")), "dispatch": bool(a.get("dispatch")), "disabled": a.get("disabled", ""), "spare": bool(a.get("spare"))}
                           for a in e["agent"].values()],
                "previews": [{"id": p["id"], "label": p["label"], "match": p["match"], "entry": p["entry"], "binary": bool(p.get("binary")), "render": bool(p.get("render")), "spare": bool(p.get("spare"))}
                             for p in e["preview"].values()],
                "open_with": self.config.get("open_with") or {}, "errors": e["errors"]}

    def set_config(self, b: dict) -> dict:
        """The person picks the default agent or which preview opens a file type. Other keys are refused, so the lock stays put."""
        bad = sorted(set(b) - set(SHARED))
        if bad:
            raise ValueError(f"not a setting the shell may change: {', '.join(bad)}")
        if "workspace" in b:
            if self.fixed:
                raise ValueError("the workspace was given at start (--workspace / AETHER_WORKSPACE); restart without it to change it here")
            ws = check_workspace(b["workspace"])
            was = [self.config.get("workspace") or "", *(self.config.get("recent") or [])]   # the folder left keeps its place right after the new one
            self.config["recent"] = list(dict.fromkeys(p for p in [str(ws), *was] if isinstance(p, str) and p))[:RECENT]
            self.config["workspace"] = str(ws)
            self.ws = self.runner.ws = ws
            self.ws_error, self._ext_at = "", None   # rescan: the new folder has its own extensions/
            self.relock()
        if "agent" in b:
            if b["agent"] not in self.ext()["agent"]:
                raise ValueError(f"no agent {b['agent']!r}")
            self.config["agent"] = b["agent"]
        if "open_with" in b:
            ow, previews = b["open_with"], self.ext()["preview"]
            if not isinstance(ow, dict):
                raise ValueError('open_with must be {".ext": "preview id" or null}')
            cur = dict(self.config.get("open_with") or {})
            for ext, pid in ow.items():
                if not (isinstance(ext, str) and ext.startswith(".")):
                    raise ValueError(f"not a file type: {ext!r}")
                if pid is None:
                    cur.pop(ext.lower(), None)
                elif pid in previews and (ext.lower() in previews[pid]["match"] or "*" in previews[pid]["match"]
                                          and not any(ext.lower() in p["match"] for p in previews.values())):   # "*" only where nobody else opens
                    cur[ext.lower()] = pid
                else:
                    raise ValueError(f"no preview {pid!r} for {ext}")
            self.config["open_with"] = cur
        tmp = self.cfg.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.config, ensure_ascii=False, indent=2))
        tmp.replace(self.cfg)
        return {k: self.config.get(k) for k in SHARED}

    def conflicts(self, prompt: str, sess: str) -> list:
        """The running jobs of other sessions that quote a file or folder this prompt quotes: a task is editing it now.
        The same session never runs two at once, so only another session can be in the way."""
        mine = paths_of(prompt)
        out = []
        for j in self.store.running() if mine else []:
            if session_of(j["ref"], j["task"]) == sess:
                continue
            hit = sorted(p for p in paths_of(j["prompt"]) if any(overlap(p, m) for m in mine))
            if hit:
                out.append({"job": j["id"], "task": j["task"], "title": j["title"], "paths": hit})
        return out

    def check(self, prompt: str, task, ref: str = "", confirm=False):
        if confirm is True:
            return
        t = self.store.task(task) if task else None
        hits = self.conflicts(prompt, session_of(t["ref"] if t else ref, t["id"] if t else "(new)"))
        if hits:
            raise Conflict(hits)

    def send(self, b: dict, by: str = None) -> dict:
        """by: the running job of an agent with dispatch: true that sends it with its AETHER_TOKEN (spec §4.3)."""
        text = str(b.get("text") or "").strip()
        if not text:
            raise ValueError("nothing to send")
        if by:
            return self.dispatch(b, text, by)
        for how in ("append", "edit"):
            if b.get(how):
                return self.rewrite(how, str(b[how]), text, b.get("quotes"), b.get("confirm"))
        if b.get("inject"):
            j = self.store.job(str(b["inject"]))
            if not j:
                raise ValueError("no such job to inject into")
            if self.runner.inject(j["id"], text):
                return {"injected": True, "job": j["id"]}
            nj = self.store.add_job(j["task"], text, text, j["agent"], first=True)   # too late: next in the same conversation
            self.runner.wake.set()
            return {"injected": False, "job": nj["id"], "note": "the job had ended; queued next in the same conversation"}
        self.need_ws()
        agent = str(b.get("agent") or "") or self.default_agent()
        a = self.ext()["agent"].get(agent)
        if not a:
            raise ValueError(f"no agent {agent!r}")
        if a.get("disabled"):
            raise ValueError(a["disabled"])
        if b.get("voice") and not a.get("audio"):
            raise ValueError(f"{a['label']} does not take voice (its manifest has no audio: true)")
        task = self.store.task(str(b.get("task") or ""))
        if b.get("task") and not task:
            raise ValueError("no such task")
        first, par = bool(b.get("first")), bool(b.get("parallel"))
        if first and par:
            raise ValueError("priority send or parallel send, not both")
        prompt = compose(text, b.get("quotes"))
        if par and task and self.busy(task):   # ⚡ parallel send: rather than wait behind its session's task, a new task (a session of its own) that starts now
            self.check(prompt, None, confirm=b.get("confirm"))   # every running job counts then, the busy session's included
            t = self.store.add_task(text.splitlines()[0])
            j = self.store.add_job(t["id"], text, prompt, agent)
            self.voiced(j, b)
            self.runner.wake.set()
            return {"job": j["id"], "task": t, "parallel": True}
        self.check(prompt, task and task["id"], str(b.get("ref") or ""), b.get("confirm"))
        task = task or self.store.add_task(text.splitlines()[0], str(b.get("ref") or ""))   # no task: a new one ―― a parallel send is that already
        j = self.store.add_job(task["id"], text, prompt, agent, first=first)
        self.voiced(j, b)
        self.runner.wake.set()
        return {"job": j["id"], "task": task}

    def dispatch(self, b: dict, text: str, by: str) -> dict:
        """An agent hands work to another agent (spec §4.3): as the person would send it, minus voice and the approval (a conflict is
        the agent's to report, 409). Not to an agent that dispatches too (no chains), and up to DISPATCH_MAX sends per job."""
        if b.get("append") or b.get("edit") or b.get("voice") or b.get("confirm"):
            raise Forbidden("an agent may send, or inject into a running job; not append, edit, voice or confirm")
        me = self.store.job(by)
        mine = me and session_of((self.store.task(me["task"]) or {}).get("ref", ""), me["task"])   # its own session waits for it to end
        if b.get("inject"):
            j = self.store.job(str(b["inject"]))
            if j and session_of((self.store.task(j["task"]) or {}).get("ref", ""), j["task"]) == mine:
                raise Forbidden("not into a job of its own session: it would wait for this job to end")
            target = j and self.ext()["agent"].get(j["agent"])
        else:
            t = self.store.task(str(b.get("task") or ""))
            if t and session_of(t["ref"], t["id"]) == mine:   # queued behind itself it would not run until the talk ends: a task of its own
                b = {k: v for k, v in b.items() if k not in ("task", "parallel", "first")}
            target = self.ext()["agent"].get(str(b.get("agent") or "") or self.default_agent())
        if target and target.get("dispatch"):
            raise Forbidden(f"{target['label']} dispatches too: no chains of agents sending to agents")
        n = self.runner.sends.get(by, 0)
        if n >= DISPATCH_MAX:
            raise Forbidden(f"this job has sent {DISPATCH_MAX} messages already")
        r = self.send({k: v for k, v in b.items() if k in ("text", "agent", "task", "quotes", "inject", "first", "parallel")})
        self.runner.sends[by] = n + 1
        label = target["label"] if target else str(b.get("agent") or "")
        try:
            self.store.add_line(by, f"📨 {label}: {text[:200]}", f"📨 {label}: {text}" if len(text) > 200 else None)
        except Exception:  # noqa: BLE001 ―― the step is a courtesy
            pass
        return r

    def voiced(self, j: dict, b: dict):
        """Sent from 🎙 (voice: true): its agent hears in start that the person is about to speak (spec §4.2)."""
        if b.get("voice"):
            self.runner.voiced.add(j["id"])

    def mic_ticket(self, jid: str) -> dict:
        """🎙 A single-use ticket for the WebSocket of one job's mic (a page cannot set X-Aether on a WebSocket; this POST needs it)."""
        if not self.store.job(jid):
            raise LookupError("no such job")
        if not self.runner.hears(jid):
            raise Started("this job does not take voice now (it has ended, or its agent has no audio: true)")
        return {"ticket": self.voice.ticket(jid)}

    def busy(self, task: dict) -> bool:
        """Its session runs or queues a job, so a message sent there would wait (one task per session)."""
        s = session_of(task["ref"], task["id"])
        return any(session_of(q["ref"], q["task"]) == s for q in self.store.queue())

    def move(self, jid: str, before=None) -> dict:
        """Drag a waiting message up or down in its session (📋 Tasks): it runs in the new order. Other sessions run beside it anyway, so
        only the order inside a session means anything."""
        if not self.store.job(jid):
            raise LookupError("no such job")
        if before is not None and not isinstance(before, str):
            raise ValueError("before must be a job id")
        if not self.store.move_queued(jid, before):
            raise Started("it, or one it passes, has started: nothing was changed")
        return {"job": jid, "pos": self.store.queued_before(jid) + 1}

    def parallel(self, jid: str, confirm=False) -> dict:
        """⚡ Parallel send of a waiting message. It waits only because its session runs another task (one task per session), so it
        moves to a new task ―― a session of its own ―― and starts now, beside that one. The conflict check sees every running job
        then, its old session's included."""
        j = self.store.job(jid)
        if not j:
            raise LookupError("no such job")
        if j["state"] != "queued":
            raise Started(f"it {'is running' if j['state'] == 'running' else 'has ended'}: nothing was changed")
        if not self.store.queued_before(jid) and not any(session_of(r["ref"], r["task"]) == session_of((self.store.task(j["task"]) or {}).get("ref", ""), j["task"])
                                                          for r in self.store.running()):
            return {"job": jid, "task": self.store.task(j["task"]), "note": "its session is free: it starts now as it is"}
        self.check(j["prompt"], None, confirm=confirm)
        t = self.store.add_task(j["text"].strip().splitlines()[0] if j["text"].strip() else "Untitled")
        if not self.store.move_job(jid, t["id"]):   # it started meanwhile
            self.store.update_task(t["id"], status="done")
            raise Started("it started meanwhile: nothing was changed")
        self.runner.wake.set()
        return {"job": jid, "task": t}

    def rewrite(self, how: str, jid: str, text: str, quotes, confirm=False) -> dict:
        """➕ append to / ✎ edit a message that still waits in the queue (it keeps its place). Once it has started, an append goes in
        like an inject (next in the same conversation when it ended); an edit changes nothing (Started) ―― the shell keeps the text."""
        for _ in range(3):   # another edit, or the start, may come between the read and the write: read again
            j = self.store.job(jid)
            if not j:
                raise LookupError("no such job")
            if j["state"] != "queued":
                break
            new = append(j["text"], j["prompt"], text, quotes) if how == "append" else (text, compose(text, quotes))
            self.check(compose(text, quotes), j["task"], confirm=confirm)   # what this send adds (the message's own quotes were checked when it was sent)
            if self.store.edit_job(jid, *new, was=(j["text"], j["prompt"])):
                t, first = self.store.task(j["task"]), j["text"].strip().splitlines()[0]
                if how == "edit" and t and t["title"] == (first.strip()[:80] or "Untitled"):   # the task was named after this message: follow it
                    self.store.update_task(t["id"], title=new[0].splitlines()[0])
                return {"job": jid, how: True}
        if how == "edit":
            raise Started(f"it {'is running' if j['state'] == 'running' else 'has ended'}: nothing was changed (your text stays in ③)")
        prompt = compose(text, quotes)
        if self.runner.inject(jid, prompt):
            return {"job": jid, "injected": True, "note": "it had started: injected into the running conversation"}
        nj = self.store.add_job(j["task"], text, prompt, j["agent"], first=True)
        self.runner.wake.set()
        return {"job": nj["id"], "injected": False, "note": "it had ended: queued next in the same conversation"}


def hostname(value, url: bool = False):
    """The name in a Host header (url: in an Origin), lower case, without port or brackets. None: nothing to check."""
    if not value or value == "null":
        return None
    v = (urlparse(value).netloc if url else value).strip().lower()
    if v.startswith("["):
        return v[1:v.find("]")] if "]" in v else v
    return v.rsplit(":", 1)[0] if v.count(":") == 1 else v


def allowed_host(name: str, extra=()) -> bool:
    """extra: names, or ".example.com" for that domain and every name under it (a proxy's own domain: only it answers for those names)."""
    if name == "localhost" or name in extra or any(e.startswith(".") and (name.endswith(e) or name == e[1:]) for e in extra):
        return True
    try:
        ipaddress.ip_address(name)   # a page can only send an IP as Host when it was opened by that IP: nothing to rebind
        return True
    except ValueError:
        return False


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
                self.send_header("Content-Security-Policy", "sandbox allow-scripts allow-modals")
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
                    if not q.is_file() and q.name in PAGE_SHARED:
                        return STATIC / PAGE_SHARED[q.name]
                    inside = (q == root or root in q.parents) and not any(q == d or d in q.parents for d in deny)
                    return q if inside and q.is_file() else None
                body = bundle(body.decode("utf-8", errors="replace"), near).encode()
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self._send(200, body, ctype, sandbox)

        def _mic(self, jid: str, ticket: str):
            """🎙 GET /api/jobs/<id>/audio?ticket= with Upgrade: websocket → 101, then the mic runs on this thread (voice.py)."""
            key = self.headers.get("Sec-WebSocket-Key", "")
            if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
                return self._json({"error": "a WebSocket upgrade is needed"}, 400)
            if self.headers.get("Origin") == "null" or not core.voice.redeem(jid, ticket):
                return self._json({"error": "forbidden"}, 403)
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", voice.accept(key))
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            core.voice.serve(voice.Socket(self.rfile, self.wfile), jid, core.runner, core.store)

        def _host_ok(self) -> bool:
            if not core.peer_ok(self.client_address[0]):
                print(f"[refused] peer {self.client_address[0]} (allow_remote is off)  host={self.headers.get('Host')!r}  {self.command} {self.path[:80]}", flush=True)
                self._json({"error": "forbidden: only this machine may connect (settings.json allow_remote lets others in)"}, 403)
                return False
            if core.host_ok(self.headers.get("Host"), self.headers.get("Origin")):
                return True
            print(f"[refused] host={self.headers.get('Host')!r} origin={self.headers.get('Origin')!r} peer {self.client_address[0]}  {self.command} {self.path[:80]}", flush=True)   # add the name to settings.json hosts if it is yours
            self._json({"error": "forbidden host: open the page by 127.0.0.1 or localhost, or add the name to settings.json hosts"}, 403)
            return False

        def do_GET(self):
            if not self._host_ok():
                return
            u = urlparse(self.path)
            path, q = unquote(u.path), {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if path.startswith("/api/jobs/") and path.endswith("/audio"):
                    return self._mic(path.split("/")[3], q.get("ticket", ""))
                if path.rsplit("/", 1)[-1] in PAGE_SHARED and (path.startswith("/x/") or path.startswith("/files/")):
                    return self._file(STATIC / PAGE_SHARED[path.rsplit("/", 1)[-1]], False)
                if path == "/":
                    return self._file(STATIC / "index.html", False)
                if path.startswith("/static/"):
                    return self._file(files.resolve(STATIC, path[len("/static/"):]), False)
                if path.startswith("/files/"):
                    ws = core.need_ws()
                    return self._file(files.resolve(ws, path[len("/files/"):], core.protect), True, ws, core.protect)
                if path.startswith("/x/"):
                    xid, _, rest = path[3:].partition("/")
                    p = core.ext()["preview"].get(xid)
                    if not p:
                        return self._json({"error": "no such extension"}, 404)
                    return self._file(files.resolve(Path(p["dir"]), rest), True, Path(p["dir"]))
                if path == "/api/info":
                    return self._json(core.info())
                if path == "/api/poll":
                    return self._json({"rev": core.store.rev(), "reloading": core.runner.hold})
                if path == "/api/tasks":
                    return self._json(core.store.tasks(None if q.get("all") else "doing"))
                if path == "/api/queue":
                    q = core.store.queue()
                    for j in q:
                        j["quotes"] = quotes_of(j.pop("prompt"))   # the labels only: a quote's text can be long
                    return self._json(q)
                if path == "/api/jobs":
                    jobs = core.store.jobs(q.get("task") or None)
                    for j in jobs:
                        if j["state"] == "queued":
                            j["pos"] = core.store.queued_before(j["id"]) + 1
                    return self._json({"jobs": jobs, "task": core.store.task(q.get("task") or "")})
                if path == "/api/files":
                    return self._json(files.listing(core.need_ws(), q.get("path", ""), core.protect))
                if path.startswith("/api/paste/"):
                    return self._file(core.pastes.path(path.rsplit("/", 1)[1]), False)
                if path == "/api/render/img":
                    return self._file(core.renders.image(q.get("ext", ""), q.get("path", ""), q.get("key", ""), q.get("name", "")), False)
                if path == "/api/read":
                    return self._json({"path": q.get("path", ""), "text": files.read(core.need_ws(), q.get("path", ""), core.protect)})
                return self._json({"error": "not found"}, 404)
            except NoWorkspace as e:
                return self._json({"error": str(e)}, 409)
            except files.Outside as e:
                return self._json({"error": str(e)}, 403)
            except FileNotFoundError:
                return self._json({"error": "not found"}, 404)
            except ValueError as e:
                return self._json({"error": str(e)}, 400)

        def do_POST(self):
            if not self._host_ok():
                return
            u = urlparse(self.path)
            path, by = u.path, None
            if self.headers.get("X-Aether") != "1" or self.headers.get("Origin") == "null":
                tok = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()   # an agent's AETHER_TOKEN (spec §4.3)
                by = core.runner.bearer(tok) if tok and self.headers.get("Origin") is None else None
                if not by or not (path == "/api/send" or (path.startswith("/api/jobs/") and path.endswith("/stop"))):
                    return self._json({"error": "forbidden"}, 403)
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if path == "/api/upload":   # a file dropped on the explorer: the body is the file, not JSON
                    q = {k: v[0] for k, v in parse_qs(u.query).items()}
                    return self._json({"path": files.upload(core.need_ws(), q.get("path", ""), q.get("name", ""), self.rfile, n, core.protect)})
                if path == "/api/paste":   # an image pasted into ③: the body is the image
                    return self._json(core.pastes.add(self.rfile, n, self.headers.get("Content-Type", "")))
                b = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if not isinstance(b, dict):
                    raise ValueError("body must be an object")
                if path == "/api/send":
                    return self._json(core.send(b, by))
                if path == "/api/render":
                    a = (str(b.get("ext") or ""), str(b.get("path") or ""))
                    return self._json(core.renders.request(*a, force=b.get("force") is True, wait=b.get("wait") is True,
                                                           page=int(b.get("page") or 0), width=int(b.get("width") or 0)))
                if path == "/api/config":
                    return self._json(core.set_config(b))
                if path == "/api/tasks":
                    return self._json(core.store.add_task(str(b.get("title") or ""), b.get("ref") or ""))
                if path.startswith("/api/tasks/"):
                    tid = path.rsplit("/", 1)[1]
                    if not core.store.task(tid):
                        return self._json({"error": "no such task"}, 404)
                    return self._json(core.store.update_task(tid, b.get("title"), b.get("status"), b.get("ref")))
                if path.startswith("/api/paste/") and path.endswith("/drop"):
                    return self._json({"dropped": core.pastes.drop(path.split("/")[3])})
                if path.startswith("/api/jobs/") and path.endswith("/stop"):
                    return self._json({"state": core.runner.stop(path.split("/")[3])})
                if path.startswith("/api/jobs/") and path.endswith("/move"):
                    return self._json(core.move(path.split("/")[3], b.get("before") or None))
                if path.startswith("/api/jobs/") and path.endswith("/parallel"):
                    return self._json(core.parallel(path.split("/")[3], b.get("confirm")))
                if path.startswith("/api/jobs/") and path.endswith("/audio"):
                    return self._json(core.mic_ticket(path.split("/")[3]))
                return self._json({"error": "not found"}, 404)
            except Conflict as e:
                return self._json({"error": str(e), "conflict": e.hits}, 409)
            except (NoWorkspace, Started) as e:
                return self._json({"error": str(e)}, 409)
            except Forbidden as e:
                return self._json({"error": str(e)}, 403)
            except files.Outside as e:
                return self._json({"error": str(e)}, 403)
            except (LookupError, FileNotFoundError) as e:
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
    core.runner.api = f"http://{'127.0.0.1' if host in ('', '0.0.0.0', '::') else host}:{srv.server_address[1]}/"   # for agents with dispatch: true
    srv.core = core
    return srv


def serve_in_thread(*a, **kw):
    srv = serve(*a, **kw)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
