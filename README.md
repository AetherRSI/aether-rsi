# AetherRSI

A small local workbench for coding agents: **send a message → it queues → an agent runs it → you watch, inject, or stop.**
The core does three things ― 💬 Messages, 📋 Tasks, 📂 Files. Everything else is an extension that speaks one protocol ([spec/custom.md](spec/custom.md)).
Python 3.9+ standard library only. No build step, no dependencies.

## Start

```bash
pip install aether-rsi    # or from a clone: pip install .
aether                    # http://127.0.0.1:8030/ ― offers a SampleProject on the first run
```

Python 3.9+ on macOS, Linux or Windows (WSL). From a clone, `python3 -m aether` works too (`--workspace DIR`, `--port N`, `--reload`).

### The built-in Claude Code agent needs Vertex AI

The agent that comes with the core, **Claude Code, is for Claude on Google Cloud Vertex AI only**. Before the first message, put the
**path of a service-account key** in `settings.json` (beside the clone, or `~/.aether-rsi/settings.json` for a pip install):

```bash
aether setup vertex --project your-project-id --region global --key /abs/path/to/vertex-key.json
```

How to get the key and enable the models, step by step: [aether/fallback/agent/claude-code/README.md](aether/fallback/agent/claude-code/README.md).
Without `vertex` in `settings.json`, Claude Code is not switched to Vertex. The **Echo** agent of the SampleProject runs without any of this.

## Extensions

A folder with `aether.json`, put in `<workspace>/extensions/` or listed in `settings.json`. Check one with `aether check <folder>`.

| Kind | What it is | Guide |
|:--|:--|:--|
| 👁 Preview | a page that shows a file type | [spec/preview.md](spec/preview.md) |
| 🤖 Agent | a program that reads and writes JSON lines | [spec/agent.md](spec/agent.md) |
| 🧩 App | a folder with a page and rules for the agent | [spec/app.md](spec/app.md) |

## Safe by default

Binds to 127.0.0.1, keeps agents out of the core and its data, and runs extension pages in sandboxed iframes.

## More

- [spec/custom.md](spec/custom.md) ― customizing in general: the screen, start and workspace, settings.json, the manifest, pages and the bar, safety and the lock, the HTTP API, tests, releases
- [spec/preview.md](spec/preview.md) · [spec/agent.md](spec/agent.md) (voice, dispatch, the screen) · [spec/app.md](spec/app.md) ― each kind of extension, protocol v0.1 included
- `conformance/` ― the tests (`python3 -m unittest discover -s conformance -t .`)

Status: v0.1 draft. License: MIT ([LICENSE](LICENSE)).
