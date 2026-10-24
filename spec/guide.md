# AetherRSI — Guide

The full guide. The short version is the [README](../README.md).

A small, local workbench for working with coding agents: **send a message → it queues → an agent runs it → you watch, inject, or stop**.
The core does only three things. Everything else is an extension that speaks one protocol ([spec/v0.1.md](v0.1.md)).

| Core | What it does |
|:--|:--|
| 💬 Messages | Composer with quote chips (`@1`, `@2`…; every quote taken puts its `@n` where the composer's cursor was, and “Clear all” drops them at once when there are two or more), a queue that runs one task per session ―― every session's first waiting task starts at once, the next one of a busy session waits (▾ priority send · ⚡ parallel send: a new task of its own that starts now instead of waiting · agent), live steps, ↪ quote / inject, ⏹ stop. A message still waiting can be quoted (📎: what you send is added to it, its quotes numbered after its own), edited (✎: ③ gets it back, sending rewrites it in place) or sent in parallel (⚡: it leaves its busy session for a new task of its own and starts now), and dragged up or down among its session's waiting ones in 📋 Tasks to change the order it runs in (a finger holds it first · Alt+↑/↓); once it runs, 📎 injects and ✎ changes nothing. A bubble shows these as icons only (📎 ✎ ⚡ ⏹). An image pasted into the composer (Cmd+V) becomes a quote “🖼 Pasted image n” with a thumbnail, its @n at the cursor: the file is kept outside the workspace (`~/.aether-rsi/paste/`), ✕ removes it, and anything 3 days old (or past 200 MB) is swept unless a waiting or running message still quotes it. The Claude Code agent hands it over as an image block. When a message (or ⚡) quotes a file or folder that another session's running job is editing, the shell asks before it is sent (⚠ Another task is editing this now · Send anyway / Cancel · a new message can also Queue after it: it waits in that task's queue and runs after the edit) |
| 📋 Tasks | Above the conversation, with a line you can drag. 🧭 All is the icon left of ✕ in its heading (every task's messages; it stays there when the list is folded). Below, three sections. 🔄 In progress: what runs and what waits (numbered within its session), bundled by session ―― a task's `ref` up to `#` (e.g. `robosim-live/sessions/12`, set by an app through `POST /api/tasks`), or the task's own conversation when it has no ref; a session with a queue gets a heading, one with nothing waiting is a single row with its name before the text. 👀 To review: the tasks whose jobs all ended and that nobody marked done (how its last job ended is an icon: done, failed, stopped ―― the word is its tooltip); A task whose last reply asks you something (a question, a choice to make, “tell me…” at its end: `asks` in `GET /api/tasks`) comes first, as an amber spinner that turns and halts, again and again, beside a chat icon ―― alive but held until you answer in ③. the check button at the end of a row closes that one task (marks it done; a session's row: its newest task, the next one takes the row) and, when it was the open one, opens the row that took its place; the double check in its heading marks them all done. ✅ Done: the tasks marked done (`status: "done"`; sending to one again brings it back to 🔄). In 👀 and ✅ a session is one row (its newest task), its count (▸ n) lists the rest; a task whose thread holds 2 or more messages has a ▸ at its left, which lists them under the row (each instruction, how it ended, when ―― click one to scroll the conversation to it); newest first, 20 at a time (… more for the rest). The header counts what is in progress, waiting for you and to review; a row shows `@n` as the chip of what it quotes and ends in …, a menu of what its job can do: 📎 Quote, and ⏹ Stop while it runs, or ✎ Edit, ⚡ Parallel send, ⏹ Stop while it waits; a row of 👀 adds ✓ Mark done, of ✅ ↩ Back to review (a session's row: all of its tasks in that section). This is the only place to switch the conversation (there is no breadcrumb over it). Click a row to open its conversation below; ✕ folds the list to one line and ▾ opens it again. Each message belongs to a task; one task = one agent conversation |
| 📂 Files | The panel on the right. An explorer of the workspace (keyboard, resizable). Files open in a preview extension; clicking a folder that is an app runs it (📁 Contents shows its files). Drop files or folders from the desktop on it to add them (a taken name becomes “name (2)”, nothing is replaced). ⌘/Ctrl + click or Shift + click / Shift + ↑↓ picks several rows; 📎 n in its header (or Enter) quotes them all in ③ |

Python 3.9+ standard library only. No build step, no dependencies.

## Start

```bash
git clone <this repo> aether-rsi && cd aether-rsi
python3 -m aether                  # http://127.0.0.1:8030/  → the page asks for the workspace folder
python3 -m aether --workspace ~/work --port 8040   # or fix it for this run
python3 -m aether --reload         # working on the core: saved Python code is swapped in without a restart
```

Or install with pip. The package carries a SampleProject (`apps/hello-app` and sample previews and the Echo agent):

```bash
pip install aether-rsi             # from a clone: pip install .
aether                             # first start from a terminal: "Make a sample project at ./SampleProject? [Y/n]"
aether init [DIR]                  # make it without asking (default ./SampleProject; a taken name gets -2, -3 …)
aether --no-init                   # never ask: the page asks for a folder. Same flags: --workspace --port --data · aether check <folder>
```

The question comes only when no workspace is saved, `--workspace` is not given and both stdin and stdout are a terminal (CI and pipes are
never asked). Y copies the SampleProject and saves it as the workspace, the way the page's form does; nothing is ever replaced. n leaves
it to the page, as before. Claude Code and the plain-text preview come with the core (`aether/fallback/`), so the sample does not copy them.

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
| `allow_remote` | `true` lets other machines connect. Default `false`: only this one (a proxy in front, such as code-server or a tunnel, runs here too) |
| `hosts` | More names the page may be opened by, for a proxy in front (e.g. `["code.example.com"]`, or `".example.com"` for a domain and every name under it; also `AETHER_HOSTS=a,b`). Google Cloud Shell's web preview (`<port>-$WEB_HOST`) passes without it. IP addresses and `localhost` always pass; any other Host or Origin gets 403, so a site whose name was rebound to 127.0.0.1 cannot reach the core |

The core reads it again when it changes. Only the key's path is passed, never its contents. A bad entry is skipped and shown as an error;
while the core is locked, agents may not write the file.

Extensions still come by `git clone` (below). Pick **Echo** to try everything without an LLM. **Claude Code** needs `claude` on the PATH (or `AETHER_CLAUDE=/path/to/claude`).
**Gemini Argon** needs `gemini` (Gemini CLI) signed in — or `AETHER_GEMINI=/path/to/gemini`; the model is `gemini-4-argon` (`AETHER_GEMINI_MODEL`).
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
{ "aether": "0.1", "kind": "preview", "id": "md-preview", "label": "Markdown", "match": [".md"], "entry": "index.html" }
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

A file the browser cannot draw faithfully (a .pptx) can be drawn by a program instead: `"render": ["{python}", "{dir}/render.py"]` in the
manifest. The core runs it once per version of the file ―― when the page asks, and ahead of time when a job that quoted the file ends ――
and `aether.render()` hands the page images over (`{page, width}`: one page larger). The bar's 🔄 draws them again as it reads the file. See spec §3.2.

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

🎙 **Voice** (`"audio": true`, spec §4.2): the shell shows a mic beside Send. It sends ③ as a new message (or, with ↪ on a running job,
opens the mic into it); the core carries PCM16 both ways over a WebSocket (`aether/voice.py`, a single-use ticket from a POST) and the
agent's stdin/stdout (`{"type":"audio","data"}` in · `{"audio"}` `{"heard"}` `{"said"}` `{"interrupted"}` out). What was said stays as
🎙 / 🔊 steps. `echo-agent` plays your voice back; `gemini-live/agent.py` talks through Gemini Live (`gemini-3.8-live`, Vertex
us-central1) and hands the work to the other agents without stopping the conversation.

📨 **Dispatch** (`"dispatch": true`, spec §4.3): the agent gets `AETHER_API` + `AETHER_TOKEN` (this job only) and sends to other agents
through `/api/send` with `Authorization: Bearer`, so what it hands on is a task of its own in 📋 Tasks (queue, conflict check and lock
as for the person; no chains, 20 sends per job). 🖱 **The screen** (spec §4.4): while the mic is open, an agent with audio asks
`{"ui": {"op": "snapshot" | "click" | "type" | "key" | "scroll"}}` and the shell answers through the mic's socket ―― `aetherUI` in
`aether-sdk.js` lists what a mouse or keyboard can use (the shell and, as `f1`, `f2`…, the page in the panel) and acts on it by number.

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
- **Opening a folder is not running its code.** Only folders the person trusts (`aether trust <folder>`, kept in `config.json` `trusted`; `aether init` trusts the sample it makes) may run their own `extensions/` agents and `render` programs, or lend their ids to them; agents start there with the folder's own settings, hooks and MCP servers. Elsewhere Claude Code starts with `--setting-sources user --strict-mcp-config` and Gemini CLI does not start. `aether trust` refuses to run inside an agent's job (`AETHER_AGENT=1`). An agent with a shell can still do what you can: trust is about what runs before anyone looks.
- **The Vertex key is a secret to the agents' tools**: its path comes as `AETHER_SECRETS`, and the Claude Code adapter denies Read/Edit/Write on it. The agent process itself still has the key (it must, to call Vertex): give it a service account that can only call the model.
- **Only this machine connects** unless `settings.json` `allow_remote` is `true`.
- **DNS rebinding is refused**: every request's Host (and Origin) must be an IP address, `localhost` or a name in `settings.json` `hosts`.
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

Icons: the shell draws its icons from [Material Icons](https://mui.com/material-ui/material-icons/) (the paths MUI ships in `@mui/icons-material`, MIT; the icons are Google's, Apache-2.0),
kept in `aether/static/icons.js` and drawn by `mui("Name")` ―― no font, no CDN, they draw offline in the text's colour. Use them for new icons; to add one,
copy its `d="…"` from `https://unpkg.com/@mui/icons-material@6.5.0/esm/<Name>.js`. (`icon()` in core.js picks the icon of a file type.)
Every icon is **one colour** (2026-10-24): the shell's own controls, the marks of file types, the agents' logos (their shape filled with the text colour)
and the extensions' bar items (`icon` in spec §3.1). A label that starts with an emoji the shell knows ("⬇ Download") is drawn as its icon; the data keeps
its emoji (quote labels, agent steps). Previews load the same icons with `<script src="aether-icons.js"></script>`.
Emoji still in older parts of the shell move over as those parts are touched.

Status: v0.1 draft. License: not chosen yet (see issue.md).
