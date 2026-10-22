# AetherRSI

A small, local workbench for working with coding agents: **send a message → it queues → an agent runs it → you watch, inject, or stop**.
The core does only three things. Everything else is an extension that speaks one protocol ([spec/v0.1.md](spec/v0.1.md)).

| Core | What it does |
|:--|:--|
| 💬 Messages | Composer with quote chips (`@1`, `@2`…), a queue that runs one task per session ―― every session's first waiting task starts at once, the next one of a busy session waits (▾ priority send · ⚡ parallel send: a new task of its own that starts now instead of waiting · agent), live steps, ↪ quote / inject, ⏹ stop. A message still waiting can be quoted (📎: what you send is added to it, its quotes numbered after its own), edited (✎: ③ gets it back, sending rewrites it in place) or sent in parallel (⚡: it leaves its busy session for a new task of its own and starts now), and dragged up or down among its session's waiting ones in 📋 Tasks to change the order it runs in (a finger holds it first · Alt+↑/↓); once it runs, 📎 injects and ✎ changes nothing. A bubble shows these as icons only (📎 ✎ ⚡ ⏹). When a message (or ⚡) quotes a file or folder that another session's running job is editing, the shell asks before it is sent (⚠ Another task is editing this now · Send anyway / Cancel) |
| 📋 Tasks | Above the conversation, with a line you can drag. 🧭 All is the icon left of ✕ in its heading (every task's messages; it stays there when the list is folded). Below, what runs and what waits (numbered within its session), bundled by session ―― a task's `ref` up to `#` (e.g. `robosim-live/sessions/12`, set by an app through `POST /api/tasks`), or the task's own conversation when it has no ref. The header counts sessions, running and queued; a row shows `@n` as the chip of what it quotes and ends in …, a menu of what its job can do: 📎 Quote, and ⏹ Stop while it runs, or ✎ Edit, ⚡ Parallel send, ⏹ Stop while it waits (a past row: 📎 Quote its last message). then 🕘 Past: the tasks with nothing running or waiting, newest first, bundled by session the same way (20 at a time, … more for the rest). This is the only place to switch the conversation (there is no breadcrumb over it). Click a row to open its conversation below; ✕ folds the list to one line and ▾ opens it again. Each message belongs to a task; one task = one agent conversation |
| 📂 Files | The panel on the right. An explorer of the workspace (keyboard, resizable). Files open in a preview extension; clicking a folder that is an app runs it (📁 Contents shows its files) |

Python 3.9+ standard library only. No build step, no dependencies.

## Start

```bash
git clone <this repo> aether-rsi && cd aether-rsi
python3 -m aether                  # http://127.0.0.1:8030/  → the page asks for the workspace folder
python3 -m aether --workspace ~/work --port 8040   # or fix it for this run
python3 -m aether --reload         # working on the core: saved Python code is swapped in without a restart
```

Or install the core with pip (no samples):

```bash
pip install aether-rsi             # from a clone: pip install .
aether                             # same flags: --workspace --port --data · aether check <folder>
```

`--reload` watches `aether/*.py`. On a save it waits until the files settle, checks that they compile and import in a fresh
interpreter (if not, the old code keeps serving and the log says why), then replaces itself with the same command (same pid and port)
and hands the running agents over: they keep running, the new code reads on from where the old one stopped. Nothing waits for them to
end and no job is cut. The shell's html/js/css never need it: a page reload picks them up.

The workspace is the folder 📂 Files shows and agents work in. A fresh install has none: the page opens a form for its absolute path
(`~/…` works; your home or a disk root is refused) and keeps it in `~/.aether-rsi/config.json` `workspace` for the next start.
Change it later from ⚙ in the explorer. `--workspace` / `AETHER_WORKSPACE` win and lock the form for that run.

### settings.json (this machine)

Copy `settings.example.json` to `settings.json` beside it (git ignores it; a pip install reads `~/.aether-rsi/settings.json`, `AETHER_SETTINGS` overrides both):

| Key | What it does |
|:--|:--|
| `extensions` | Folders of extensions read whatever the workspace is (after its own `extensions/`), so switching the workspace keeps your agents |
| `vertex` | `credentials` (path of the service-account key), `project`, `region`. Every agent gets them as `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT`, `CLOUD_ML_REGION` / `GOOGLE_CLOUD_LOCATION`, plus `CLAUDE_CODE_USE_VERTEX=1` and `GOOGLE_GENAI_USE_VERTEXAI=true`, even when the core was not started from your shell |
| `env` | More environment for agents (wins over `vertex`) |

The core reads it again when it changes. Only the key's path is passed, never its contents. A bad entry is skipped and shown as an error;
while the core is locked, agents may not write the file.

Extensions still come by `git clone` (below). Pick **🔁 Echo** to try everything without an LLM. **🤖 Claude Code** needs `claude` on the PATH (or `AETHER_CLAUDE=/path/to/claude`).
**💎 Gemini Argon** needs `gemini` (Gemini CLI) signed in — or `AETHER_GEMINI=/path/to/gemini`; the model is `gemini-4-argon` (`AETHER_GEMINI_MODEL`).
Data (SQLite, logs, config) lives in `~/.aether-rsi/` (`--data` or `AETHER_DATA`), never inside the core.

## Extensions: three kinds

An extension is a folder with `aether.json`. Install with `git clone` into `<workspace>/extensions/` (or `~/.aether-rsi/extensions/`), directly or under a group folder such as `preview/` or `agent/`;
remove by deleting the folder, reload the page. Check one with `python3 -m aether check <folder>`.
Spares ship in `aether/fallback/` (the `claude-code` agent and the `text-preview` preview): each is used only when no folder has an extension with its id,
so a workspace without `extensions/` still has an agent and still shows files.
The sample extensions (md, json, pptx and text previews; echo-agent, claude-code, gemini-argon) live outside this checkout:
copy them into a workspace's `extensions/`, or list their folder in `settings.json` `extensions` to have them everywhere.

### 1. 👁 Preview — a file type becomes a page

```json
{ "aether": "0.1", "kind": "preview", "id": "md-preview", "label": "📝 Markdown", "match": [".md"], "entry": "index.html" }
```

```html
<script src="aether-sdk.js"></script>
<script>
  aether.on("open", ({ name, text }) => render(text));        // the core hands you the file
  someBlock.onclick = () => aether.quote("Intro", blockText);  // becomes @n under the composer
  aether.bar([{ id: "dl", label: "⬇ Download", run: () => aether.download() }]);   // your controls, in the shell's bar next to 📎 🔄
</script>
```

`aether.bar` buttons can carry a ▾ menu (`options`, with `{head}` lines), be a drop-down (`select: true`) or ask for full screen first
(`full: true`, for a slideshow). The core's own controls (path, ← →, open with, 📎, 🔄) stay; see spec §3.1.
A page prints in place (`window.print()` with an `@media print` copy): a sandboxed page cannot open a child frame to print from.

### 2. 🤖 Agent — any program that reads and writes JSON lines

```json
{ "aether": "0.1", "kind": "agent", "id": "my-agent", "label": "My agent", "command": ["{python}", "{dir}/agent.py"], "inject": true, "guard": true }
```

```text
stdin  ← {"type":"start","prompt":"…","session":null,"cwd":"…","protect":[…]}   then  {"type":"inject","text":"…"}
stdout → {"step":"📖 reading"}  {"session":"abc"}  {"done":true,"reply":"…"}   or  {"error":"…"}
```

`extensions/agent/echo-agent/agent.py` is the whole protocol in 60 lines;
`claude-code/agent.py` puts Claude Code behind it, and
`gemini-argon/agent.py` Gemini CLI (`protect` becomes an admin policy that denies `write_file`/`replace`).

### 3. 🧩 App — a folder with a page and rules for the agent

```json
{ "aether": "0.1", "kind": "app", "id": "hello-app", "label": "Ideas board", "entry": "index.html", "agent_rules": "CLAUDE.md" }
```

The person uses `index.html` (it reads its own files with `aether.read("data.json")`); quote the folder and send, and the agent
is told to read `CLAUDE.md` first. See the `samples/hello-app/` sample.
An app may give `"url": "http://127.0.0.1:<port>/"` instead of `entry` when a program on this machine serves its page (e.g. robosim-live's `live.py` on :8770):
clicking the folder opens that page in its own origin (through a relay the shell asks first, because the page would share AetherRSI's origin).

## Safe by default

- **The core is locked.** The file tree cannot leave the workspace (`..`, absolute paths and symlinks out are refused), and agents get
  the core and data folders as `protect` (Claude Code: `permissions.deny` on Edit/Write). Agents that do not declare `"guard": true` are off.
  To edit the core itself, open a workspace that contains your clone of aether-rsi (the clone or a folder above it): the lock comes off
  there and returns when you switch back. `~/.aether-rsi/config.json` `core_locked` (`true`/`false`) overrides this. Hover the version in the header to see 🔒/🔓 and why.
- **Extension pages never get the core's origin**: sandboxed iframes, `Content-Security-Policy: sandbox`, postMessage only.
  The core inlines a page's own scripts, styles and images, so it also works behind a login proxy (an opaque origin sends no cookies).
  A page can draft a message (`aether.send`) but only the person's click sends it.
- Binds to `127.0.0.1`. All URLs are relative, so it runs unchanged behind a reverse proxy prefix (e.g. `/proxy/8030/`).

## Tests

```bash
python3 -m unittest discover -s conformance -t .      # the samples are found via AETHER_SAMPLES or the saved workspace
AETHER_PRIVATE_WORDS="name,company" python3 -m unittest conformance.test_clean   # keep your own words out of a fork
```

No network beyond 127.0.0.1 and no LLM. An extension conforms when `python3 -m aether check` reports no problems.

## Layout

```text
aether/        the core (server, queue, store, files, extensions, static/)
spec/          the protocol (v0.1)
conformance/   tests that define "conforms"
settings.example.json   the template for settings.json (this machine's extension folders and Vertex credentials)
```

Status: v0.1 draft. License: not chosen yet (see [issue.md](issue.md)).
