# SampleProject

A workspace made by `aether init` (or the first `aether` start). 📂 Files shows this folder; agents work in it.

1. Click `apps/hello-app` in 📂 Files: the app opens. Select a line, ↪ quote it, and send “add an idea: …”.
2. Pick an agent in the composer: **Echo (demo)** needs nothing; **Claude Code** needs `claude` on the PATH.
3. Copy `apps/hello-app` to make your own app (change `id` in its `aether.json`), then `aether check apps/<yours>`.

| Folder | What is in it |
|:--|:--|
| `apps/hello-app/` | An app: `aether.json` (kind `app`) + `index.html` + `data.json` + `CLAUDE.md` (the agent's rules for it) |
| `extensions/preview/` | Previews: Markdown (with mermaid), JSON, PowerPoint, images/audio/video. Plain text comes with the core |
| `extensions/agent/` | Echo (demo). Claude Code comes with the core |

Add an extension by putting its folder under `extensions/<kind>/` and reloading the page. `mermaid.min.js` (in
`extensions/preview/md-preview/`) is mermaid, MIT License, © Knut Sveidqvist and contributors.
