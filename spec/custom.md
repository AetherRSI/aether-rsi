# AetherRSI — Customizing

How to run, configure and extend AetherRSI. The short version is the [README](../README.md).
Each kind of extension has its own page: [👁 Preview](preview.md) · [🤖 Agent](agent.md) · [🧩 App](app.md).

Protocol v0.1, status: draft. The core in this repository is the reference implementation; `conformance/` decides pass or fail.
The § numbers are the protocol's and stay the same across the four pages (§1–§3.1, §5–§7 here, §3.2 in [preview.md](preview.md),
§3.0 in [app.md](app.md), §4 in [agent.md](agent.md)), so `spec §4.2` in the code is [agent.md §4.2](agent.md#42-voice-audio-true).

## The core

A small, local workbench for working with coding agents: **send a message → it queues → an agent runs it → you watch, inject, or stop**.
The core does only three things. Everything else is an extension.

| Core | What it does |
|:--|:--|
| 💬 Messages | Composer with quote chips (`@1`, `@2`…; every quote taken puts its `@n` where the composer's cursor was, and “Clear all” drops them at once when there are two or more), a queue that runs one task per session ―― every session's first waiting task starts at once, the next one of a busy session waits (▾ priority send · ⚡ parallel send: a new task of its own that starts now instead of waiting · agent), live steps, ↪ quote / inject, ⏹ stop. A message still waiting can be quoted (📎: what you send is added to it, its quotes numbered after its own), edited (✎: ③ gets it back, sending rewrites it in place) or sent in parallel (⚡: it leaves its busy session for a new task of its own and starts now), and dragged up or down among its session's waiting ones in 📋 Tasks to change the order it runs in (a finger holds it first · Alt+↑/↓); once it runs, 📎 injects and ✎ changes nothing. A bubble shows these as icons only (📎 ✎ ⚡ ⏹). An image pasted into the composer (Cmd+V) becomes a quote “🖼 Pasted image n” with a thumbnail, its @n at the cursor: the file is kept outside the workspace (`~/.aether-rsi/paste/`), ✕ removes it, and anything 3 days old (or past 200 MB) is swept unless a waiting or running message still quotes it. The Claude Code agent hands it over as an image block. When a message (or ⚡) quotes a file or folder that another session's running job is editing, the shell asks before it is sent (⚠ Another task is editing this now · Send anyway / Cancel · a new message can also Queue after it: it waits in that task's queue and runs after the edit) |
| 📋 Tasks | Above the conversation, with a line you can drag. 🧭 All is the icon left of ✕ in its heading (every task's messages; it stays there when the list is folded). Below, three sections. 🔄 In progress: what runs and what waits (numbered within its session), bundled by session ―― a task's `ref` up to `#` (e.g. `sim-viewer/sessions/12`, set by an app through `POST /api/tasks`), or the task's own conversation when it has no ref; a session with a queue gets a heading, one with nothing waiting is a single row with its name before the text. 👀 To review: the tasks whose jobs all ended and that nobody marked done (how its last job ended is an icon: done, failed, stopped ―― the word is its tooltip); A task whose last reply asks you something (a question, a choice to make, “tell me…” at its end: `asks` in `GET /api/tasks`) comes first, as an amber spinner that turns and halts, again and again, beside a chat icon ―― alive but held until you answer in ③. the check button at the end of a row closes that one task (marks it done; a session's row: its newest task, the next one takes the row) and, when it was the open one, opens the row that took its place; the double check in its heading marks them all done. ✅ Done: the tasks marked done (`status: "done"`; sending to one again brings it back to 🔄). In 👀 and ✅ a session is one row (its newest task), its count (▸ n) lists the rest; a task whose thread holds 2 or more messages has a ▸ at its left, which lists them under the row (each instruction, how it ended, when ―― click one to scroll the conversation to it); newest first, 20 at a time (… more for the rest). The header counts what is in progress, waiting for you and to review; a row shows `@n` as the chip of what it quotes and ends in …, a menu of what its job can do: 📎 Quote, and ⏹ Stop while it runs, or ✎ Edit, ⚡ Parallel send, ⏹ Stop while it waits; a row of 👀 adds ✓ Mark done, of ✅ ↩ Back to review (a session's row: all of its tasks in that section). This is the only place to switch the conversation (there is no breadcrumb over it). Click a row to open its conversation below; ✕ folds the list to one line and ▾ opens it again. Each message belongs to a task; one task = one agent conversation |
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

Data (SQLite, logs, config) lives in `~/.aether-rsi/` (`--data` or `AETHER_DATA`), never inside the core.

### The workspace

The workspace is the folder 📂 Files shows and agents work in. A fresh install has none: the page opens a form for its absolute path
(`~/…` works; your home or a disk root is refused) and keeps it in `~/.aether-rsi/config.json` `workspace` for the next start.
Change it later from ⚙ in the explorer. `--workspace` / `AETHER_WORKSPACE` win and lock the form for that run.

The workspace is the person's choice, made in the shell (`POST /api/config {"workspace": "/abs/path"}`, kept in `<data>/config.json`)
or fixed at start (`--workspace`). Until one is set, file and send requests answer 409. Extensions cannot set it: like every shared key,
only the shell writes it (a sandboxed page has an opaque origin and cannot send `X-Aether`).
Each change puts the new folder first in `<data>/config.json` `recent` (the folder left right after it, at most 10, no repeats).
The core writes `recent`, nobody else: it is not a shared key. `/api/info` `recent` lists the ones that still exist, and the shell
offers them in the workspace dialog so one click switches back.

### settings.json (this machine)

Copy `settings.example.json` to `settings.json` beside it (git ignores it; a pip install reads `~/.aether-rsi/settings.json`, `AETHER_SETTINGS` overrides both):

| Key | What it does |
|:--|:--|
| `extensions` | Folders of extensions read whatever the workspace is (after its own `extensions/`), so switching the workspace keeps your agents |
| `vertex` | `credentials` (path of the service-account key), `project`, `region`. Every agent gets them as `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT`, `CLOUD_ML_REGION` / `GOOGLE_CLOUD_LOCATION`, plus `CLAUDE_CODE_USE_VERTEX=1` and `GOOGLE_GENAI_USE_VERTEXAI=true`, even when the core was not started from your shell |
| `env` | More environment for agents (wins over `vertex`) |
| `allow_remote` | `true` lets other machines connect. Default `false`: only this one (a proxy in front, such as code-server or a tunnel, runs here too) |
| `hosts` | More names the page may be opened by, for a proxy in front (e.g. `["code.example.com"]`, or `".example.com"` for a domain and every name under it; also `AETHER_HOSTS=a,b`). Google Cloud Shell's web preview (`<port>-$WEB_HOST`) passes without it. IP addresses and `localhost` always pass; any other Host or Origin gets 403, so a site whose name was rebound to 127.0.0.1 cannot reach the core |

The core reads it again when it changes. Only the key's path is passed, never its contents. A bad entry is skipped and shown as an error
(`/api/info` `errors`); while the core is locked, agents may not write the file (it is in `protect`). What agents receive from it: [agent.md §4.1](agent.md#41-environment).

## Extensions

An extension is **one folder with an `aether.json` manifest**. The core reads manifests only. It never imports extension code:
pages run in sandboxed iframes and agents run as separate processes.

| Kind | What it is | Page |
|:--|:--|:--|
| 👁 Preview | a file type becomes a page | [preview.md](preview.md) |
| 🤖 Agent | any program that reads and writes JSON lines | [agent.md](agent.md) |
| 🧩 App | a folder with a page and rules for the agent | [app.md](app.md) |

Install with `git clone` into `<workspace>/extensions/` (or `~/.aether-rsi/extensions/`), directly or under a group folder such as `preview/` or `agent/`;
remove by deleting the folder, reload the page. Check one with `python3 -m aether check <folder>`: an extension conforms when it reports no problems.
Spares ship in `aether/fallback/` (the `claude-code` agent and the `text-preview` preview): each is used only when no folder has an extension with its id,
so a workspace without `extensions/` still has an agent and still shows files. The `claude-code` spare is for Vertex AI only and needs
`settings.json` `vertex` with the path of a key ([its README](../aether/fallback/agent/claude-code/README.md)).
The sample extensions (md, json, pptx and text previews; echo-agent, claude-code, gemini-argon) live outside this checkout:
copy them into a workspace's `extensions/`, or list their folder in `settings.json` `extensions` to have them everywhere.

## 1. Manifest

```json
{ "aether": "0.1", "kind": "preview", "id": "md-preview", "label": "Markdown", "match": [".md"], "entry": "index.html" }
```

Fields every kind has:

| Field | Rule |
|:--|:--|
| `aether` | Protocol version. In 0.x the minor must equal the core's. From 1.0: same major, minor not newer than the core |
| `kind` | `preview`, `agent` or `app` |
| `id` | `name` or `author.name`, each part `[a-z0-9][a-z0-9-]{0,39}`. Use `author.name` for anything you share (§2.1). First one found wins; later duplicates are reported and skipped |
| `label` | What the UI shows |

The fields of each kind: [preview.md §1](preview.md#1-manifest-fields) (`entry`, `match`, `binary`, `render`) ·
[agent.md §1](agent.md#1-manifest-fields) (`command`, `inject`, `audio`, `dispatch`, `guard`, `icon`) ·
[app.md §1](app.md#1-manifest-fields) (`entry`, `url`, `agent_rules`, `ports`, `history`).

Unknown fields are ignored. A folder whose manifest breaks a rule is skipped and listed in `/api/info` `errors`.

## 2. Where extensions live

| Kind | Found in |
|:--|:--|
| preview, agent | `<workspace>/extensions/` and `<data>/extensions/` (data defaults to `~/.aether-rsi`), as `<folder>/` or one level down as `<group>/<folder>/`. A group is a folder without `aether.json`. A group named after a kind (`preview/`, `agent/`, `app/`) only holds that kind |
| app | any folder of the workspace's file tree |
| preview, agent (machine) | the folders listed in `settings.json` `extensions` (this machine's settings, see [agent.md §4.1](agent.md#41-environment)), read after the workspace's `extensions/` and before `<data>/extensions/`, whatever the workspace is. A folder listed twice is read once |
| spare | `aether/fallback/` inside the core, read last. A spare only fills an `id` neither folder above has (a workspace without `extensions/` still gets the `claude-code` agent and the `text-preview` preview); when the workspace has the same `id`, the spare is skipped quietly. `/api/info` marks it `"spare": true` |

Install = `git clone` into one of these folders. Uninstall = delete the folder. The core rescans when the folder or a group changes.

### 2.1 Extensions from different authors

Extensions written by different people must run side by side on anyone's machine. What they could fight over, and who decides:

| They could clash on | Rule |
|:--|:--|
| Pages | Never: each page is its own sandboxed frame with an opaque origin (no shared DOM, cookies or storage) |
| Apps | Never: an app is identified by its folder, not by its `id` |
| `id` | Share with `author.name` (e.g. `ada.md-preview`). On a clash the first found wins (workspace, then data, folders in name order) and the other is listed in `/api/info` `errors` with the folder that took the id |
| A file type (two previews match `.md`) | **The person picks.** The shell offers "open with" when more than one preview matches and stores the pick in `<data>/config.json` `open_with` (`{".md": "ada.md-preview"}`). Without a pick, the first found opens |
| Shared settings (`agent`, `open_with`) | Only the person changes them, through the shell (`POST /api/config`). Extensions cannot: pages have no access to the API, and agents get the data folder in `protect` while the core is locked. `core_locked` is not writable through the API at all |

## 3. Pages (preview and app)

A preview and an app (one with `entry`) are both a page. The core loads `entry` in `<iframe sandbox="allow-scripts allow-modals" allow="fullscreen">` and serves it with `Content-Security-Policy: sandbox allow-scripts allow-modals`.
`allow-modals` is there for `print()` (a preview's print / PDF button); `fullscreen` for a slideshow. Neither gives the page a way out of its origin.
The page therefore has an opaque origin: it cannot call the core's API, read cookies or reach the parent DOM.
Previews are served from `x/<id>/`, apps from `files/<path>/`.
Clicking an app folder (in the tree, a folder list or a link) runs the app; its files are one click away (📁 Contents).
Because the origin is opaque, the page's own requests carry no cookies, so behind an authenticating proxy they would fail.
The core therefore delivers an HTML page as **one document**: relative `<script src>`, `<link rel="stylesheet">` and `<img src>` inside
the folder are inlined, and `<script src="aether-sdk.js"></script>` becomes the SDK. Anything else (data, other files) is read with `read`.
`<script src="aether-icons.js"></script>` (before the SDK) gives the page the shell's icons: `mui("Name")` is a one-colour Material icon
(https://mui.com/material-ui/material-icons/, the text's colour) as an `<svg>`, `muiText("… {AttachFile} …")` the words with icons inside.

Messages are `postMessage` objects `{aether: "0.1", type, ...}`. The core accepts messages only from the frame it opened.

| Direction | type | Fields | Meaning |
|:--|:--|:--|:--|
| core → page | `open` | `path`, `name`, `text` (preview), `data` (preview with `binary: true`) or `folder: true` (app), `top?`, `state?`, `error?` | What to show. Sent after load. `top` is the scroll position to restore (← →); `state` is what the page last gave to `state` |
| core → page | `scroll.to` | `top` | Scroll back to `top` (← → inside the same file) |
| core → page | `rev` | `rev` | Something changed in the core (a job moved, a task changed) |
| core → page | `dest` | `task` (`{id, title}` or null) | The task the composer is addressed to |
| core → page | `theme` | `dark` | Colour scheme of the shell |
| core → page | `reply` | `id`, `ok`, `text` or `error` | Answer to `read` and `file.open` (to `fetch`: `status`, `statusText`, `contentType`, `data` (ArrayBuffer) instead of `text`) |
| page → core | `quote.add` | `label`, `text` | Add a quote chip to the composer. The person sends it |
| page → core | `send` | `text` | Put text in the composer. **Not sent**: sending is always the person's click |
| page → core | `task.open` | `id` | Open a task's conversation |
| page → core | `read` | `id`, `path` | Read a text file inside the extension's own folder (an app's folder, or a preview's `x/<id>/`) |
| page → core | `render` | `id`, `force?`, `wait?`, `page?`, `width?` | Previews with `render` in the manifest: the pages of the open file ([preview.md §3.2](preview.md#32-pages-drawn-by-a-program-render)) |
| page → core | `file.open` | `id`, `path`, `hash?` | Follow a link: `path` is in the data folder (the page resolves a relative link against `open.path`). The core opens it and keeps ← → history; `reply` says whether it exists |
| page → core | `fetch` | `id`, `url`, `method?`, `body?`, `contentType?` | Apps: a server on this machine, one of the manifest's `ports` ([app.md](app.md#fetch-a-server-on-this-machine-ports)) |
| page → core | `url.open` | `url` | Open an `http(s)`/`mailto` link in a new tab (the frame has no `allow-popups`) |
| page → core | `scroll` | `top` | Where the page is scrolled, so ← → can come back to it |
| page → core | `download` | `name?`, `data?`, `mime?` | Download the shown file (the frame itself cannot) ―― or, with `data` (an ArrayBuffer, transferred), those bytes as `name` (a video the page encoded…) |
| page → core | `state` | `value` | Remember a small JSON value (≤ 4 KB) for this extension in this browser |
| page → core | `bar` | `items` | Put the page's own controls in the shell's bar (§3.1). Replaces what the page put before; `[]` clears |
| core → page | `bar` | `id`, `value` | A control of the page was clicked (`value` = the picked option, or `""`) |
| core → page | `fullscreen` | `on` | The frame left (`false`) full screen that a `full` control started |
| page → core | `fullscreen` | `on: false` | End that full screen (the frame cannot: the full-screen element is in the shell's document) |

`aether-sdk.js` wraps them: `aether.on("open", …)`, `aether.quote(label, text)`, `aether.send(text)`, `aether.read(path)`,
`aether.bar(items)`, `aether.download()`, `aether.render()`, `aether.fetch(url)`… (examples in [preview.md](preview.md) and [app.md](app.md)).
A page prints in place (`window.print()` with an `@media print` copy): a sandboxed page cannot open a child frame to print from.

#### 3.1 The bar

The bar above the page belongs to the core: the path, ← →, “open with”, 📎 quote and 🔄 reload are always there and a page cannot
hide or relabel them. Next to them, the page that is open (a preview or an app) may put **its own controls** with `bar`:

```json
{ "type": "bar", "items": [
  { "id": "present", "icon": "Slideshow", "label": "Present", "full": true, "options": [{ "value": "simple", "label": "Simple" }] },
  { "id": "unit", "label": "Quote by", "value": "block", "select": true, "options": [{ "value": "block", "label": "Block" }, { "value": "section", "label": "Section" }] },
  { "id": "sel", "icon": "AttachFile", "label": "Quote selection", "disabled": true }
] }
```

- An item is a button. With `options` it gets a ▾ menu (the button itself sends `""`); with `select: true` it is a drop-down that sends the picked value
- An option is `{value, label, icon?, title?, full?}` (`title` shows under the label in the menu) or `{head}`, a heading line that cannot be picked
- `icon` (item or option): the name of a Material icon the shell has (`aether-icons.js`), drawn in one colour before the label. An empty label leaves
  the icon alone, named by `title`. A label that starts with an emoji the shell knows ("⬇ Download") is drawn the same way (older pages)
- `full: true` (on the item, or on one option, which wins): the core puts the frame in full screen **before** sending `bar`
  (a click in the shell does not activate the frame, so the page could not). A print / PDF option leaves `full` off
- Text only (labels and titles are set as text, never HTML). At most 6 items, 12 options each, labels up to 24 characters; the rest is dropped
- Controls belong to the frame that sent them: they go away when another file or app opens

## Safe by default

- **The core is locked** (§6). The file tree cannot leave the workspace (`..`, absolute paths and symlinks out are refused), and agents get
  the core and data folders as `protect` (Claude Code: `permissions.deny` on Edit/Write). Agents that do not declare `"guard": true` are off.
  To edit the core itself, open a workspace that contains your clone of aether-rsi (the clone or a folder above it): the lock comes off
  there and returns when you switch back. `~/.aether-rsi/config.json` `core_locked` (`true`/`false`) overrides this. Hover the version in the header to see 🔒/🔓 and why.
- **Extension pages never get the core's origin**: sandboxed iframes, `Content-Security-Policy: sandbox`, postMessage only (§3).
  The core inlines a page's own scripts, styles and images, so it also works behind a login proxy (an opaque origin sends no cookies).
  A page can draft a message (`aether.send`) but only the person's click sends it.
- **Opening a folder is not running its code.** Only folders the person trusts (`aether trust <folder>`, kept in `config.json` `trusted`; `aether init` trusts the sample it makes) may run their own `extensions/` agents and `render` programs, or lend their ids to them; agents start there with the folder's own settings, hooks and MCP servers. Elsewhere Claude Code starts with `--setting-sources user --strict-mcp-config` and Gemini CLI does not start. `aether trust` refuses to run inside an agent's job (`AETHER_AGENT=1`). An agent with a shell can still do what you can: trust is about what runs before anyone looks.
- **The Vertex key is a secret to the agents' tools**: its path comes as `AETHER_SECRETS`, and the Claude Code adapter denies Read/Edit/Write on it. The agent process itself still has the key (it must, to call Vertex): give it a service account that can only call the model.
- **Only this machine connects** unless `settings.json` `allow_remote` is `true`.
- **DNS rebinding is refused**: every request's Host (and Origin) must be an IP address, `localhost` or a name in `settings.json` `hosts`.
- Binds to `127.0.0.1`. All URLs are relative, so it runs unchanged behind a reverse proxy prefix (e.g. `/proxy/8030/`).

## 5. Core HTTP API (for the shell; extensions do not call it)

All URLs are relative, so the core also works under a proxy prefix. POST requires the header `X-Aether: 1` and rejects `Origin: null`.
See the docstring of `aether/server.py` for the list of endpoints. (An agent with `dispatch` calls a few of them with a token: [agent.md §4.3](agent.md#43-dispatch-dispatch-true).)

A task may carry a `ref` (one line, up to 300 characters): where an app keeps it, e.g. `sim-viewer/sessions/12#n7-3`. The core
stores it and never reads it; the shell bundles 📋 Tasks by the part before `#` (the session). Set it with `POST /api/tasks {title, ref}`,
`POST /api/tasks/<id> {ref}` or `POST /api/send {…, ref}` when the message starts a new task.

**One task per session**: a session is a task's `ref` up to `#`, or the task alone when it has none. The first waiting job of every
session that has nothing running starts at once, each in an agent process of its own (no limit on how many sessions run); the next job
of a busy session waits for it. `/api/queue` gives a waiting job `pos`, its place in its session.
`POST /api/jobs/<id>/move {before?}` changes that order: the waiting job goes just before `before` (another waiting job of the same session),
or last when it is left out. Only the order inside a session moves (sessions run beside each other anyway); `400` for a `before` outside
its session, `409` once the job (or one it passes) runs or ended. The shell does it by dragging a waiting row in 📋 Tasks (Alt+↑/↓ from the keyboard).
`POST /api/jobs/<id>/parallel` (⚡ parallel send) is for a job that waits only because its session is busy: it moves to a new task (a
session of its own) and starts now. The same choice exists when sending: `POST /api/send {…, parallel: true}` to a task whose session runs or queues a job
makes the message a new task of its own (named after its first line) that starts now; to a free session it is sent as it is
(`first` and `parallel` together are refused).

Two sessions may still touch the same files. A send (`POST /api/send`, also `append` / `edit`) or a ⚡ parallel send whose quotes name a
workspace file or folder (`📄 path`, `📁 path/`, `🧩 path/`) that another session's running job quotes too (the same path, or one inside
the other) is refused with `409 {error, conflict: [{job, task, title, paths}]}` and nothing changes. The shell shows who is editing what
and asks the person; approved, it sends the same request again with `confirm: true`.

`POST /api/upload?path=<folder>&name=<file name>` writes the raw body (not JSON) as a file of the workspace folder `path`, making the
folder when it is missing, and answers `{path}`. It never replaces a file: a taken name becomes `name (2).ext`, `name (3).ext`… It refuses
`403` outside the workspace or inside a protected folder (§6) and `400` for a name with a folder in it, a name the tree hides or a body over 500 MB.
The shell sends one request per file when files or folders from the desktop are dropped on the explorer (on a folder: into it; on a file:
beside it; on the empty space: the workspace root).

## 6. Lock

By default the core is locked: the file tree and file reads stay inside the workspace and never enter the core or data folders,
and agents receive those folders in `protect`. The rule, in order:

1. `<data>/config.json` `core_locked` set to `true` or `false` wins.
2. Otherwise the core is unlocked when the workspace is, or contains, the core's own git clone (the folder holding `aether/`, `spec/`
   and `conformance/`). Opening a folder above the core is how the person says "I am working on the core". A pip install
   (`site-packages`) never unlocks this way: open a clone to edit the core.
3. Otherwise it is locked.

The lock is recomputed when the workspace changes. The shell shows 🔓 or 🔒 with the reason (`/api/info` `lock_reason`) when you hover the version in its header.

## 7. Not in v0.1

`serve` (a backend process per extension behind `x/<id>/`, HTTP and WebSocket) is planned for v0.2. `render` ([preview.md §3.2](preview.md#32-pages-drawn-by-a-program-render)) covers the
one case previews needed now ―― drawing a file once per version ―― without a process that keeps running.
Also planned before 1.0, so that third-party extensions keep working across versions and machines:
settings an extension owns (its own `ext.<id>` space, never the shared keys) · a transition window where the core still accepts the
previous 0.x manifests · `requires` in the manifest (commands, environment variables, Python packages kept inside the extension folder),
checked by `python3 -m aether check` and reported in `/api/info` `errors`.

## Tests

```bash
python3 -m unittest discover -s conformance -t .      # the samples are found via AETHER_SAMPLES or the saved workspace
AETHER_PRIVATE_WORDS="name,company" python3 -m unittest conformance.test_clean   # keep your own words out of a fork
```

No network beyond 127.0.0.1 and no LLM. An extension conforms when `python3 -m aether check` reports no problems.
Two opt-in tests reach the network to build: `AETHER_PIP_TEST=1` (`test_pip`, installs into a fresh venv) and `AETHER_DIST=dist` (`test_dist`, checks the built wheel and sdist).

## Releases

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: the tag must equal `aether.VERSION`, the conformance tests, `test_dist` and `test_pip` must pass, then the build goes to TestPyPI and waits for a person to approve the `pypi` environment before PyPI. Publishing is trusted publishing (no token is stored).

## Layout

```text
aether/        the core (server, queue, store, files, extensions, static/)
spec/          this guide and the protocol (v0.1): custom.md, preview.md, agent.md, app.md
conformance/   tests that define "conforms"
.github/       the release workflow
settings.example.json   the template for settings.json (this machine's extension folders and Vertex credentials)
```

## Icons

The shell draws its icons from [Material Icons](https://mui.com/material-ui/material-icons/) (the paths MUI ships in `@mui/icons-material`, MIT; the icons are Google's, Apache-2.0),
kept in `aether/static/icons.js` and drawn by `mui("Name")` ―― no font, no CDN, they draw offline in the text's colour. Use them for new icons; to add one,
copy its `d="…"` from `https://unpkg.com/@mui/icons-material@6.5.0/esm/<Name>.js`. (`icon()` in core.js picks the icon of a file type.)
Every icon is **one colour** (2026-10-24): the shell's own controls, the marks of file types, the agents' logos (their shape filled with the text colour)
and the extensions' bar items (`icon` in §3.1). A label that starts with an emoji the shell knows ("⬇ Download") is drawn as its icon; the data keeps
its emoji (quote labels, agent steps). Previews load the same icons with `<script src="aether-icons.js"></script>` (§3).
Emoji still in older parts of the shell move over as those parts are touched.

Status: v0.1 draft. License: MIT (see LICENSE).
