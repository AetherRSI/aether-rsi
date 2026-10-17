# plan — AetherRSI

## Goal

Make working with coding agents a shared, standard thing across teams: a tiny core everyone runs, and a protocol so previews,
agents and apps from different teams plug in without touching the core (the way MCP standardised tools).

## Shape

- Core = messages (queue, steps, inject, stop) + tasks (in progress) + files (tree, previews, apps). Nothing else.
- Extensions = folder + `aether.json`. Three kinds: preview / agent / app. Pages are sandboxed iframes; agents are processes.
- Standard library only; `python3 -m aether`; data outside the core; locked by default.

## Requirements (v0.1)

1. Runs with no dependency and no code-server; binds 127.0.0.1; relative URLs (works under a proxy prefix).
2. By default nothing can write to the core: path guard on the file tree, `protect` for agents, extensions never imported.
3. Every rule of the protocol is checked by `conformance/` (no network beyond localhost, no LLM).
4. The samples in `projects/` cover all three kinds, and the echo agent covers the whole agent protocol.
5. No personal paths or names in the repo (`conformance/test_clean.py`).

## Test scenarios

- Send without a task → a task is created and the echo agent replies with the prompt (quotes included).
- Send to the same task again → the agent gets the same session back.
- `/slow` job: ↪ inject while running → appears in the reply; ⏹ stop → state `stopped`; inject after the end → next job, same task.
- Open `notes/welcome.md` → md-preview renders; click a block → quote chip `@1`.
- Open `hello-app` → it reads `data.json` through `aether.read`; its button drafts a message but does not send it.
- `..`, absolute paths, symlinks out → 403. POST without `X-Aether: 1` or with `Origin: null` → 403.
