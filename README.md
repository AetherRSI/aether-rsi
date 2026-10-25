# AetherRSI

A small local workbench for coding agents: **send a message → it queues → an agent runs it → you watch, inject, or stop.**
The core does three things ― 💬 Messages, 📋 Tasks, 📂 Files. Everything else is an extension that speaks one protocol ([spec/v0.1.md](spec/v0.1.md)).
Python 3.9+ standard library only. No build step, no dependencies.

## Start

```bash
pip install aether-rsi    # or from a clone: pip install .
aether                    # http://127.0.0.1:8030/ ― offers a SampleProject on the first run
```

Python 3.9+ on macOS, Linux or Windows (WSL). From a clone, `python3 -m aether` works too (`--workspace DIR`, `--port N`, `--reload`).

## Extensions

A folder with `aether.json`, put in `<workspace>/extensions/` or listed in `settings.json`. Check one with `aether check <folder>`.

| Kind | What it is |
|:--|:--|
| 👁 Preview | a page that shows a file type |
| 🤖 Agent | a program that reads and writes JSON lines |
| 🧩 App | a folder with a page and rules for the agent |

## Safe by default

Binds to 127.0.0.1, keeps agents out of the core and its data, and runs extension pages in sandboxed iframes.

## More

- [spec/guide.md](spec/guide.md) ― the full guide (the screen, settings, each kind of extension, voice, tests)
- [spec/v0.1.md](spec/v0.1.md) ― the protocol · `conformance/` ― the tests (`python3 -m unittest discover -s conformance -t .`)

Status: v0.1 draft. License: MIT ([LICENSE](LICENSE)).
