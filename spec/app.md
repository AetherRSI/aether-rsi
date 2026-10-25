# AetherRSI — 🧩 App: a folder with a page and rules for the agent

An app is any folder of the workspace with an `aether.json` of `kind: "app"`: the person uses its page, the agent follows its rules.
Its page is sandboxed like a preview's and speaks the same messages ([custom.md §3](custom.md#3-pages-preview-and-app)); the fields every kind
has: [custom.md](custom.md#1-manifest). Other kinds: [👁 Preview](preview.md) · [🤖 Agent](agent.md).

```json
{ "aether": "0.1", "kind": "app", "id": "hello-app", "label": "Ideas board", "entry": "index.html", "agent_rules": "AGENTS.md" }
```

The person uses `index.html` (it reads its own files with `aether.read("data.json")`); quote the folder and send, and the agent
is told to read `AGENTS.md` first. See the `aether/sample_project/apps/hello-app/` sample.
An app may give `"url": "http://127.0.0.1:<port>/"` instead of `entry` when a program on this machine serves its page (e.g. a simulator's live viewer on :8770):
clicking the folder opens that page in its own origin (through a relay the shell asks first, because the page would share AetherRSI's origin). See §3.0.

An app needs no install: it is found anywhere in the workspace's file tree, and it is identified by its folder, not by its `id`
([custom.md §2](custom.md#2-where-extensions-live)). Clicking the folder (in the tree, a folder list or a link) runs the app; its files are
one click away (📁 Contents). Its page is served from `files/<path>/`, and `read` reads files inside the app's folder.

An app that sends tasks (scripts in its folder, through `AETHER_URL`: [agent.md §4.1](agent.md#41-environment)) can give each a `ref`,
e.g. `sim-viewer/sessions/12#n7-3`: 📋 Tasks bundles them by the part before `#`, and each session runs one task at a time
([custom.md §5](custom.md#5-core-http-api-for-the-shell-extensions-do-not-call-it)).

## 1. Manifest fields

| Field | Rule |
|:--|:--|
| `entry` | A file inside the folder (relative, no `..`) |
| `url` | Instead of `entry`: a page that a program on this machine serves, `http://127.0.0.1:<port>/…` (or `localhost`, `[::1]`). See §3.0 |
| `agent_rules` | A file inside the folder with instructions for the agent (e.g. `AGENTS.md`). A quote of the app asks the agent to read it first ([agent.md §4.1](agent.md#41-environment)) |
| `ports` | Ports of servers on this machine the page may `fetch` through the shell (below), e.g. `[8771]`. Never the core's own port |
| `history` | Its past data: paths inside the folder (they need not exist yet), e.g. `["runs", "logs"]`. ⬇ then offers "Without past data": the zip leaves them out (as empty folders) and leaves out venvs, to try the app elsewhere |

### fetch: a server on this machine (`ports`)

The page's message `fetch` (`id`, `url`, `method?`, `body?`, `contentType?`; `aether.fetch(url, {method, body, headers})`): the shell
fetches `http://127.0.0.1:<port>/…` for the page, `port` one of the manifest's `ports` (GET, or POST with a string body). Through a
relay it goes to the relay's `/proxy/<port>/` with the shell's cookies ―― the sandboxed page's own requests carry none (a `SameSite=Lax`
cookie is not sent from an opaque origin). When the page is on another host (Cloud Shell's web preview, a tunnel) the core fetches it:
`GET|POST api/port/<port>/<path>` with `X-Aether: 1` and `X-Aether-App: <the app's folder>`. The `reply` carries `status`,
`statusText`, `contentType` and `data` (an ArrayBuffer) instead of `text`.

#### 3.0 An app served by a program (`url`)

An app may name `url` instead of `entry`: a page that a program on this machine serves (a live viewer such as a simulator's).
The shell opens it in `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads">`, so it
runs as it would in a tab of its own (modules, storage, its own requests). Only loopback hosts are allowed. Through a relay
(`…/proxy/<port>/`) the shell rewrites it to the same relay's `/proxy/<its port>/`. If that puts the page on the core's own origin, the
page could use the core's API, so the shell shows a warning and opens it only when the person presses ▶ (or offers a tab of its own).
If the program does not answer, the shell says so and offers 🔄. The page does not get the SDK's `open` message; quoting it works from the bar (📎).
