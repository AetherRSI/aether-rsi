# issue — AetherRSI

| # | Issue | State |
|:--:|:--|:--|
| 1 | License (MIT or Apache-2.0) not chosen. Until then the repo stays private | open (owner decides) |
| 2 | Where the public repo lives (personal or organisation) and the final name check (trademark) | open (owner decides) |
| 3 | `serve` (an extension backend behind `x/<id>/`) is not in v0.1, so apps with a server cannot be samples yet | v0.2 |
| 4 | `protect` relies on the agent: Claude Code denies Edit/Write, but a permissive shell mode could still write. Default mode is `acceptEdits` | known limit |
| 5 | Previews get the whole file as text (2 MB cap). Binary previews (PDF, slides) need `serve` or a `read` for bytes | v0.2 |
| 6 | One queue, one job at a time. Parallel lanes were left out on purpose | by design |
