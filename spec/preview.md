# AetherRSI — 👁 Preview: a file type becomes a page

A preview shows the files of one type in 📂 Files. It is a page in a sandboxed iframe; everything it shares with an app's page
(the sandbox, the messages, the bar) is in [custom.md §3](custom.md#3-pages-preview-and-app). Where to put it and the fields every kind has:
[custom.md](custom.md#extensions). Other kinds: [🤖 Agent](agent.md) · [🧩 App](app.md).

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
(`full: true`, for a slideshow). The core's own controls (path, ← →, open with, 📎, 🔄) stay; see [custom.md §3.1](custom.md#31-the-bar).
A page prints in place (`window.print()` with an `@media print` copy): a sandboxed page cannot open a child frame to print from.

A file the browser cannot draw faithfully (a .pptx) can be drawn by a program instead: `"render": ["{python}", "{dir}/render.py"]` in the
manifest. The core runs it once per version of the file ―― when the page asks, and ahead of time when a job that quoted the file ends ――
and `aether.render()` hands the page images over (`{page, width}`: one page larger). The bar's 🔄 draws them again as it reads the file. See §3.2.

Two previews may match the same file type: the person picks one with “open with” ([custom.md §2.1](custom.md#21-extensions-from-different-authors)).
The samples (md, json, pptx and text) live outside this checkout; `text-preview` also ships as a spare in `aether/fallback/`.

## 1. Manifest fields

| Field | Rule |
|:--|:--|
| `entry` | A file inside the folder (relative, no `..`) |
| `match` | File extensions, e.g. `[".md", ".markdown"]`. `"*"` = a fallback: it opens only the file types no other preview matches (files without an extension included) |
| `binary` | `true`: the page gets the file as bytes (`data`, an ArrayBuffer, up to 50 MB) instead of `text` (UTF-8, up to 2 MB). For pptx, images, archives |
| `render` | argv list (`{dir}` = the extension folder, `{python}` = the core's Python): a program that draws the file's pages as images, for what a browser cannot draw faithfully (a .pptx by LibreOffice). The core runs it, the page asks for the pages with `render`. See §3.2 |

A preview is served from `x/<id>/`; `read` reads files inside that folder.

#### 3.2 Pages drawn by a program (`render`)

A page cannot start a program, and some files can only be drawn faithfully by one. A preview may name one in `render`; the core
runs it as its own process (like an agent: it is the extension's code, so install only what you trust) and keeps what it drew under
`<data>/render/<preview id>/<hash of the path>/<file version>/`. The version is the file's mtime and size; only the newest is kept.
Only a folder the person trusts runs its own `render` programs ([custom.md](custom.md#safe-by-default)).

- The command gets `<file> <out>`: the file (absolute) and an empty folder to fill with `p-1.png`, `p-2.png`… (zero padding is fine).
  For one page at a larger width: `<file> <out> --page N --width W --base <the folder of the full render>`, W one of 1920, 2560, 3840
  (anything else gets the normal page). Exit 0 with at least one page = success; otherwise what it printed becomes `error`.
  The working directory is `<out>`. At most two run at once; one is stopped after 300 s
- The page asks with the message `render` (`id`, `force?`, `wait?`, `page?`, `width?`; `aether.render({force, wait, page, width})`).
  `reply` carries `state`, `running`, `error`, `key`, `dir`, `pages` and `data` (an ArrayBuffer per page) ―― with `page` + `width`,
  that page drawn larger: `name`, `file`, `data`
- It is drawn when the page asks and nothing is drawn for the file as it is now (`state: "none"`, or `"stale"` while an older
  version is shown), **when a job ends that quoted the file** (an agent probably changed it, so it is ready before anyone opens it),
  and again on `force`. The shell's 🔄 asks for `force` before it opens the file again, so one button reads the file and draws its
  pages anew; meanwhile the page gets the pages drawn before with `running: true`. A failure is not retried by itself: `force` does
- `data` reaches the page through the shell (the frame's own requests carry no cookie behind a relay). `dir` / `file` are the
  absolute paths of the images, for a quote that lets the agent look at the page
- A page should keep a way to show the file without it (the program may be missing on this machine: `error`)
