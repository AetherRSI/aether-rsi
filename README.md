# AetherRSI

A small, local workbench for working with coding agents: **send a message → it queues → an agent runs it → you watch, inject, or stop**.
The core does only three things. Everything else is an extension that speaks one protocol ([spec/v0.1.md](spec/v0.1.md)).

| Core | What it does |
|:--|:--|
| 💬 Messages | Composer with quote chips (`@1`, `@2`…), a queue that runs one job at a time, live steps, ↪ inject, ⏹ stop |
| 📋 Tasks | Each message belongs to a task; one task = one agent conversation. Only tasks in progress are listed |
| 📂 Files | The workspace tree. Files open in a preview extension; folders that are apps open as apps |

Python 3.9+ standard library only. No build step, no dependencies.

## Start

```bash
git clone <this repo> aether-rsi && cd aether-rsi
python3 -m aether                  # http://127.0.0.1:8030/  (workspace: ./projects)
python3 -m aether --workspace ~/work --port 8040
```

Pick **🔁 Echo** to try everything without an LLM. **🤖 Claude Code** needs `claude` on the PATH (or `AETHER_CLAUDE=/path/to/claude`).
Data (SQLite, logs, config) lives in `~/.aether-rsi/` (`--data` or `AETHER_DATA`), never inside the core.

## Extensions: three kinds

An extension is a folder with `aether.json`. Install with `git clone` into `<workspace>/extensions/` (or `~/.aether-rsi/extensions/`),
remove by deleting the folder, reload the page. Check one with `python3 -m aether check <folder>`.
The samples in [projects/](projects/README.md) are meant to be copied.

### 1. 👁 Preview — a file type becomes a page

```json
{ "aether": "0.1", "kind": "preview", "id": "md-preview", "label": "📝 Markdown", "match": [".md"], "entry": "index.html" }
```

```html
<script src="aether-sdk.js"></script>
<script>
  aether.on("open", ({ name, text }) => render(text));        // the core hands you the file
  someBlock.onclick = () => aether.quote("Intro", blockText);  // becomes @n under the composer
</script>
```

### 2. 🤖 Agent — any program that reads and writes JSON lines

```json
{ "aether": "0.1", "kind": "agent", "id": "my-agent", "label": "My agent", "command": ["{python}", "{dir}/agent.py"], "inject": true, "guard": true }
```

```text
stdin  ← {"type":"start","prompt":"…","session":null,"cwd":"…","protect":[…]}   then  {"type":"inject","text":"…"}
stdout → {"step":"📖 reading"}  {"session":"abc"}  {"done":true,"reply":"…"}   or  {"error":"…"}
```

[`projects/extensions/echo-agent/agent.py`](projects/extensions/echo-agent/agent.py) is the whole protocol in 60 lines;
[`claude-code/agent.py`](projects/extensions/claude-code/agent.py) puts Claude Code behind it.

### 3. 🧩 App — a folder with a page and rules for the agent

```json
{ "aether": "0.1", "kind": "app", "id": "hello-app", "label": "Ideas board", "entry": "index.html", "agent_rules": "CLAUDE.md" }
```

The person uses `index.html` (it reads its own files with `aether.read("data.json")`); quote the folder and send, and the agent
is told to read `CLAUDE.md` first. See [`projects/hello-app/`](projects/hello-app/).

## Safe by default

- **The core is locked.** The file tree cannot leave the workspace (`..`, absolute paths and symlinks out are refused), and agents get
  the core and data folders as `protect` (Claude Code: `permissions.deny` on Edit/Write). Agents that do not declare `"guard": true` are off.
  To unlock (for your own machine, e.g. when fixing the core from an editor): `~/.aether-rsi/config.json` → `{"core_locked": false}`. The header shows 🔓.
- **Extension pages never get the core's origin**: sandboxed iframes, `Content-Security-Policy: sandbox`, postMessage only.
  The core inlines a page's own scripts, styles and images, so it also works behind a login proxy (an opaque origin sends no cookies).
  A page can draft a message (`aether.send`) but only the person's click sends it.
- Binds to `127.0.0.1`. All URLs are relative, so it runs unchanged behind a reverse proxy prefix (e.g. `/proxy/8030/`).

## Tests

```bash
python3 -m unittest discover -s conformance -t .
AETHER_PRIVATE_WORDS="name,company" python3 -m unittest conformance.test_clean   # keep your own words out of a fork
```

No network beyond 127.0.0.1 and no LLM. An extension conforms when `python3 -m aether check` reports no problems.

## Layout

```text
aether/        the core (server, queue, store, files, extensions, static/)
spec/          the protocol (v0.1)
conformance/   tests that define "conforms"
projects/      sample workspace with sample extensions
```

Status: v0.1 draft. License: not chosen yet (see [issue.md](issue.md)).
