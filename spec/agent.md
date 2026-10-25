# AetherRSI — 🤖 Agent: any program that reads and writes JSON lines

An agent runs the messages of 💬 Messages: one process per job, JSON lines on stdin and stdout. Where to put it and the fields every
kind has: [custom.md](custom.md#extensions). Other kinds: [👁 Preview](preview.md) · [🧩 App](app.md).

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

Pick **Echo** to try everything without an LLM. **Claude Code** needs `claude` on the PATH (or `AETHER_CLAUDE=/path/to/claude`); it also
ships as a spare in `aether/fallback/`, and that one is **for Vertex AI only**: it needs the path of a service-account key in
`settings.json` `vertex` (how to get one: [its README](../aether/fallback/agent/claude-code/README.md)). **Gemini Argon** needs `gemini` (Gemini CLI) signed in — or `AETHER_GEMINI=/path/to/gemini`; the model is `gemini-4-argon` (`AETHER_GEMINI_MODEL`).
Only a folder the person trusts runs its own `extensions/` agents, and only there do Claude Code and Gemini CLI start with the folder's
own settings, hooks and MCP servers ([custom.md](custom.md#safe-by-default)).

🎙 **Voice** (`"audio": true`, §4.2): the shell shows a mic beside Send. It sends ③ as a new message (or, with ↪ on a running job,
opens the mic into it); the core carries PCM16 both ways over a WebSocket (`aether/voice.py`, a single-use ticket from a POST) and the
agent's stdin/stdout (`{"type":"audio","data"}` in · `{"audio"}` `{"heard"}` `{"said"}` `{"interrupted"}` out). What was said stays as
🎙 / 🔊 steps. `echo-agent` plays your voice back; `gemini-live/agent.py` talks through Gemini Live (`gemini-3.8-live`, Vertex
us-central1) and hands the work to the other agents without stopping the conversation.

📨 **Dispatch** (`"dispatch": true`, §4.3): the agent gets `AETHER_API` + `AETHER_TOKEN` (this job only) and sends to other agents
through `/api/send` with `Authorization: Bearer`, so what it hands on is a task of its own in 📋 Tasks (queue, conflict check and lock
as for the person; no chains, 20 sends per job). 🖱 **The screen** (§4.4): while the mic is open, an agent with audio asks
`{"ui": {"op": "snapshot" | "click" | "type" | "key" | "scroll"}}` and the shell answers through the mic's socket ―― `aetherUI` in
`aether-sdk.js` lists what a mouse or keyboard can use (the shell and, as `f1`, `f2`…, the page in the panel) and acts on it by number.

## 1. Manifest fields

| Field | Rule |
|:--|:--|
| `command` | argv list. `{dir}` = the extension folder, `{python}` = the core's Python |
| `inject` | `true` if the agent accepts more text while running (default false) |
| `audio` | `true` if the agent takes the person's voice while it runs (§4.2; default false). The shell then offers 🎙 |
| `dispatch` | `true` if the agent may send messages to other agents through the core while it runs (§4.3; default false) |
| `guard` | `true` if the agent honours `protect` (§4). A locked core does not run agents without it ([custom.md §6](custom.md#6-lock)) |
| `icon` | A `.svg` or `.png` file inside the folder (up to 64 KB). The UI shows it in place of `label` where room is short (the label stays as the tooltip) |

## 4. Agents

The core starts `command` with the workspace as the working directory, one process per job, in its own process group.
Both directions are **JSON lines** (one object per line, UTF-8).

#### 4.1 Environment

The agent inherits the core's environment plus what `settings.json` adds ([custom.md](custom.md#settingsjson-this-machine)): `vertex` (`credentials`, `project`, `region`) becomes
`GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, `CLOUD_ML_REGION`, `GOOGLE_CLOUD_LOCATION`,
`CLAUDE_CODE_USE_VERTEX=1` and `GOOGLE_GENAI_USE_VERTEXAI=true`; `env` adds any other name and wins over `vertex`. The file is
`settings.json` beside the core's clone (`<data>/settings.json` for a pip install, `AETHER_SETTINGS` for either), read again when it
changes. Only the key's path travels, never its contents (its path also comes as `AETHER_SECRETS`, for the adapter to keep the agent's tools off it). Bad entries are skipped and listed in `/api/info` `errors`; while the core
is locked the file is in `protect`. Every agent also gets `AETHER_URL`, the core's own URL (`http://127.0.0.1:<port>`): scripts in a folder send
tasks to it whatever port the core runs on (no token: the HTTP API still needs `X-Aether: 1` from them).

core → agent (stdin):

```json
{"type": "start", "aether": "0.1", "prompt": "…", "session": "id or null", "cwd": "/abs/workspace", "protect": ["/abs/core", "/abs/data"]}
{"type": "inject", "text": "…"}
```

agent → core (stdout):

```json
{"step": "📖 README.md"}
{"step": "💻 cd /abs/path; sed -n 1,40p a.md; grep -n …", "full": "the whole command"}
{"session": "id"}
{"done": true, "reply": "…", "cost": 0.012}
{"error": "…"}
```

- `prompt` is the message followed by its quotes (`@n label` and `> text`); an app quote asks the agent to read its `agent_rules` first ([app.md](app.md)). When `session` is null and the workspace has `AGENTS.md`, the prompt
  ends with a line asking the agent to read it (one rules file for every agent, whatever file its own tool reads).
- `step` is one short line per thing the agent does. If the line cuts a longer text, `full` may carry all of it (up to 20,000 characters): the shell ends the line with … and opens the whole text on click.
- `session` is whatever the agent reported last time for the same task, so a task is one conversation.
- `inject` arrives only if the manifest says `inject: true`. The core closes stdin after `done`; text arriving later becomes the next job of the same task.
- `protect` lists folders the agent must not write to (empty when the core is unlocked). Agents declare `guard: true` to say they enforce it.
- Stop = the core sends SIGTERM (then SIGKILL) to the process group.
- Exit without `done`, or any `error` → the job fails with that message (or the tail of stderr).

#### 4.2 Voice (`audio: true`)

The person talks to a running job through the shell's 🎙. The core carries the sound both ways between the shell and the agent's
stdin/stdout. Sound is raw PCM, 16-bit little-endian, mono, base64 in the JSON line: **16 kHz from the person, 24 kHz from the agent**.

core → agent: `start` carries `"audio": true` when the message was sent from 🎙 (the person is about to speak: stay until `end`), then

```json
{"type": "audio", "data": "<base64 PCM16 16 kHz>"}
{"type": "audio", "end": true}
```

agent → core:

```json
{"audio": "<base64 PCM16 24 kHz>"}
{"heard": "what the person said"}
{"said": "what the agent said"}
{"interrupted": true}
```

- `data` arrives about every 100 ms while the mic is open. `end` = the person closed the mic: finish the conversation (the work it
  started may go on) and send `done`. A dropped connection (a reload, the network) sends nothing: the shell opens the mic again.
- `heard` / `said` are whole utterances (gather the pieces until the turn ends). The core keeps them as steps (`🎙 …` / `🔊 …`) and
  passes them to the shell; `audio` and `interrupted` (the person cut in: drop what is still to be played) only go to the shell.
- The shell's side is a WebSocket: `POST /api/jobs/<id>/audio` → `{ticket}` (single use, 30 s), then
  `GET /api/jobs/<id>/audio?ticket=…` with `Upgrade: websocket`. Binary frames are the sound (PCM16 without base64), text frames JSON:
  shell → core `{"type": "end"}`; core → shell `{"type": "wait"}` (queued), `{"type": "ready"}`, `{"heard"}`, `{"said"}`,
  `{"interrupted"}`, `{"type": "end", "state"}`. One mic per job: a second one takes over.

#### 4.3 Dispatch (`dispatch: true`)

The agent may hand work to other agents as tasks of their own, so they show in 📋 Tasks and the queue, the conflict check and the lock
apply as to a message the person sends. While its job runs it gets `AETHER_API` (the core's base URL) and `AETHER_TOKEN` (good for
that job only; a reload keeps it) and calls the core's HTTP API ([custom.md §5](custom.md#5-core-http-api-for-the-shell-extensions-do-not-call-it)) with `Authorization: Bearer <token>` in place of `X-Aether`:

- `POST api/send` `{text, agent, task?, quotes?, inject?}` (not `voice`, not `confirm`): a new task, the next message of a task, or ↪ into a running job
- `POST api/jobs/<id>/stop`, and the `GET` endpoints to follow what it sent (`api/jobs?task=`, `api/queue`, `api/tasks`)

Not to an agent that itself declares `dispatch` (no chains), and up to 20 sends per job; the core answers `403` past that.
Not into its own session either: it would wait for the sending job to end. A `task` of that session is dropped (a task of its own,
which starts now), and an `inject` into a job of it is `403`.
The job that sent keeps one step per send (`📨 agent: text`).

#### 4.4 The screen (agents with `audio: true`)

While the mic is open, the agent may read and drive the shell as the person sees it ―― the same browser, no other one. It asks with a
line on stdout and gets the answer on stdin; the core passes both over the mic's WebSocket:

```json
{"ui": {"id": 7, "op": "snapshot"}}
{"ui": {"id": 8, "op": "click", "n": 12}}
{"ui": {"id": 9, "op": "type", "n": 3, "text": "…", "enter": false}}
{"ui": {"id": 10, "op": "key", "keys": "Meta+Enter"}}
{"ui": {"id": 11, "op": "scroll", "n": 5, "dy": 400}}
```

```json
{"type": "ui", "id": 7, "result": {"items": [{"n": 12, "role": "button", "name": "Send to Claude Code", "area": "Send a message", "state": {}}], "dialog": "", "focus": "…"}}
{"type": "ui", "id": 8, "error": "…"}
```

- `snapshot` lists what a mouse or keyboard can use on screen now (buttons, links, fields, menus, tabs, tree rows…; not hidden, not
  covered), numbered. The numbers hold until the next snapshot. Items of the page open in the panel (a preview or an app that loads
  `aether-sdk.js`) are numbered `"f1"`, `"f2"`…; an app served by `url` without the SDK is not reachable.
- `click` refuses an item that something else covers (as a real click would). Each action flashes the item on screen.
- `key` reaches the page's own key handlers (⌘Enter, Escape, arrows); the browser's own defaults (Tab moving the focus) do not run.
- No mic open: the core answers at once with `error`.
