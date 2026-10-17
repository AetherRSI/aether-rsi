# projects/ — the sample workspace

`python3 -m aether` opens this folder by default (`--workspace` picks another one). Only what is in here shows in 📂 Files.

| Path | Kind | What it shows |
|:--|:--|:--|
| `extensions/md-preview/` | preview | A file type → a page. Click a block to quote it |
| `extensions/echo-agent/` | agent | The whole agent protocol in 60 lines, no LLM (inject and stop included) |
| `extensions/claude-code/` | agent | Claude Code behind the same protocol (needs `claude`) |
| `hello-app/` | app | A folder that is an app: `index.html` + `data.json` + `CLAUDE.md` for the agent |
| `notes/welcome.md` | — | Something to preview |

Copy one of them to start your own. `python3 -m aether check <folder>` tells you whether it conforms.
