"""The machine's settings: settings.json beside the core's clone (or <data>/settings.json for a pip install, or AETHER_SETTINGS).

  {"extensions": ["/abs/folder", ...],                       always read, whatever the workspace (after its extensions/)
   "vertex": {"credentials": "/abs/key.json", "project": "id", "region": "global"},   handed to every agent as the env below
   "env": {"NAME": "value"},                                  more env for agents (wins over vertex)
   "hosts": ["name.example"]}                                 more names the page may be opened by (a proxy in front); IP addresses and localhost always pass

Read again when the file changes, so editing it needs no restart. A bad entry is skipped and reported, never fatal.
The core passes the credentials file's path, never its contents. Keep settings.json out of git (settings.example.json is the template).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

VERTEX_ENV = {   # what Claude Code, Gemini CLI and the Google client libraries read
    "credentials": ["GOOGLE_APPLICATION_CREDENTIALS"],
    "project": ["ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_CLOUD_PROJECT"],
    "region": ["CLOUD_ML_REGION", "GOOGLE_CLOUD_LOCATION"],
}
VERTEX_ON = {"CLAUDE_CODE_USE_VERTEX": "1", "GOOGLE_GENAI_USE_VERTEXAI": "true"}


def where(repo: Path, data: Path, source_checkout: bool) -> Path:
    if "AETHER_SETTINGS" in os.environ:
        return Path(os.environ["AETHER_SETTINGS"]).expanduser()
    return repo / "settings.json" if source_checkout else data / "settings.json"


def parse(raw) -> tuple:
    """(settings, errors). settings = {"extensions": [Path], "env": {str: str}}."""
    out, bad = {"extensions": [], "env": {}, "hosts": []}, []
    if not isinstance(raw, dict):
        return out, ["must be a JSON object"]
    hosts = raw.get("hosts", [])
    for h in hosts if isinstance(hosts, list) else [hosts]:
        if isinstance(h, str) and h.strip() and not any(c in h for c in "/: "):
            out["hosts"].append(h.strip().lower())
        else:
            bad.append(f"hosts: {h!r} is not a host name (no scheme, port or path)")
    ext = raw.get("extensions", [])
    for e in ext if isinstance(ext, list) else [ext]:
        p = Path(e).expanduser() if isinstance(e, str) else None
        if p is None or not p.is_absolute():
            bad.append(f"extensions: {e!r} is not an absolute path")
        elif not p.is_dir():
            bad.append(f"extensions: no such folder {p}")
        else:
            out["extensions"].append(p.resolve())
    v = raw.get("vertex")
    if v is not None:
        if not isinstance(v, dict):
            bad.append("vertex must be an object")
        else:
            for k, names in VERTEX_ENV.items():
                if k not in v:
                    continue
                val = v[k]
                if not isinstance(val, str) or not val.strip():
                    bad.append(f"vertex.{k} must be a string")
                    continue
                if k == "credentials":
                    val = str(Path(val).expanduser())
                    if not Path(val).is_file():
                        bad.append(f"vertex.credentials: no such file {val}")
                        continue
                out["env"].update(dict.fromkeys(names, val))
            out["env"].update(VERTEX_ON)
    env = raw.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(x, str) for k, x in env.items()):
        bad.append('env must be {"NAME": "value"} (strings)')
    else:
        out["env"].update(env)
    return out, bad


class Settings:
    def __init__(self, path: Path):
        self.path, self._at, self._val = Path(path), None, ({"extensions": [], "env": {}}, [])

    def get(self) -> tuple:
        """(settings, errors), re-read when the file changes. No file: empty settings, no errors."""
        try:
            at = self.path.stat().st_mtime_ns
        except OSError:
            at = 0
        if at != self._at:
            self._at, val, bad = at, {"extensions": [], "env": {}}, []
            if at:
                try:
                    val, bad = parse(json.loads(self.path.read_text()))
                except (OSError, ValueError) as e:
                    bad = [f"cannot read: {e}"]
            self._val = (val, [f"{self.path.name}: {b}" for b in bad])
        return self._val
