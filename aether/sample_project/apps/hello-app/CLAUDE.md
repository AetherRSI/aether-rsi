# Ideas board — rules for the agent

This folder is an AetherRSI app (`aether.json`, kind `app`). The person sees `index.html`; you change the data.

- The data is `data.json`: `{"ideas": [{"title": str, "votes": int}]}`. Keep that shape.
- To add an idea, append to `ideas` with `votes: 0`. To vote, add 1. Do not touch `index.html` unless asked.
- Reply with one line saying what changed. The board reloads when the person reopens it.
