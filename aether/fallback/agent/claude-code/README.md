# Claude Code agent (built in) ― Vertex AI only

The agent that comes with the core (`aether/fallback/agent/claude-code/`). It puts the Claude Code CLI behind the agent protocol
([spec/agent.md](../../../../spec/agent.md)). A workspace that has its own `claude-code` in `extensions/` uses that one instead.

**It is for Claude on Google Cloud Vertex AI only.** The core switches Claude Code to Vertex (`CLAUDE_CODE_USE_VERTEX=1` and the project,
region and key) only from `settings.json` `vertex`. Without it Claude Code falls back to whatever sign-in it has of its own, which this
agent does not support. So before the first message:

1. `claude` on this machine (below)
2. a Google Cloud project that may call Claude on Vertex AI
3. a service-account key file, its **path** in `settings.json` `vertex.credentials`

## 1. Claude Code

Install the Claude Code CLI (https://docs.claude.com/en/docs/claude-code/setup) so that `claude --version` works in a terminal.
The agent looks for `AETHER_CLAUDE` (a path), then `claude` on the PATH, then (macOS) the copy inside the Claude desktop app.
You do not need to sign in to Claude Code itself: Vertex is the sign-in.

## 2. The project: Vertex AI and the Claude models

With the gcloud CLI (https://cloud.google.com/sdk/docs/install), signed in as someone who may administer the project:

```bash
gcloud auth login
PROJECT=your-project-id
gcloud config set project $PROJECT
gcloud services enable aiplatform.googleapis.com          # the Vertex AI API (the project needs billing)
```

Then turn on the Claude models in the Cloud console: **Vertex AI → Model Garden**, search “Claude”, open the model you want
(e.g. Claude Opus) and press **Enable** (accept Anthropic's terms). Do it for each model you will use. Vertex serves Claude in the
`global` region and in some single regions; `global` is the default here.

## 3. A key that can only call the model

A service account with the **Vertex AI User** role (`roles/aiplatform.user`) and nothing else: the agent process holds the key, so give
it no more than calling the model.

```bash
gcloud iam service-accounts create aether-agent --display-name "AetherRSI agents"
gcloud projects add-iam-policy-binding $PROJECT \
  --member "serviceAccount:aether-agent@$PROJECT.iam.gserviceaccount.com" --role roles/aiplatform.user
mkdir -p ~/.config/aether && chmod 700 ~/.config/aether
gcloud iam service-accounts keys create ~/.config/aether/vertex-key.json \
  --iam-account aether-agent@$PROJECT.iam.gserviceaccount.com
chmod 600 ~/.config/aether/vertex-key.json
```

Keep the key **outside the workspace and outside any git repository** (`settings.json` itself is git-ignored, the key file is not).
The core passes only the key's path, never its contents; it never shows or serves the file, and this agent denies Claude Code's own
Read/Edit/Write on it (`AETHER_SECRETS`). A shell command run by the agent could still read it, which is why the role is the narrow one.

If key creation is refused (`iam.disableServiceAccountKeyCreation`, an organisation policy), ask the project's admin for a key, or use
your own sign-in instead (step 4, `--adc`).

## 4. Put the path in settings.json

From a terminal (the page shows what is set, it never sets it):

```bash
aether setup vertex --project $PROJECT --region global --key ~/.config/aether/vertex-key.json
aether setup vertex          # no options: shows what is set (project, region, key file or own sign-in)
```

From a clone it is `python3 -m aether setup vertex …`. It writes `settings.json` beside the clone (a pip install:
`~/.aether-rsi/settings.json`; `AETHER_SETTINGS` points elsewhere). Or write it by hand from `settings.example.json`:

```json
{
  "vertex": {
    "credentials": "/abs/path/to/.config/aether/vertex-key.json",
    "project": "your-project-id",
    "region": "global"
  }
}
```

The path must be absolute (`~/` works) and the file must exist, or the entry is skipped and shown as an error (`/api/info` `errors`).
A running core reads the file again by itself: no restart. The agent then gets `GOOGLE_APPLICATION_CREDENTIALS`,
`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` and `CLAUDE_CODE_USE_VERTEX=1` ([spec/agent.md §4.1](../../../../spec/agent.md#41-environment)).

Your own sign-in instead of a key (Cloud Shell, or after `gcloud auth application-default login` with an account that may call
Vertex): `aether setup vertex --project $PROJECT --adc`. No key file is kept anywhere; `--key` switches back.

## 5. Try it

Pick **Claude Code** in the shell and send “say hello”. If it fails, the job's error says why:

| Error | What to do |
|:--|:--|
| `claude not found` | Step 1, or set `AETHER_CLAUDE` to the path of `claude` (`settings.json` `env`) |
| `vertex.credentials: no such file …` (in errors) | The path in step 4 is wrong or not absolute |
| `403` / `PERMISSION_DENIED` | The service account lacks `roles/aiplatform.user`, or the Vertex AI API is off (step 2, 3) |
| `404` / model not found | The model is not enabled in Model Garden for this project, or not in this region: enable it, or pick one that is with `AETHER_CLAUDE_MODEL` |
| It answers, but bills your Claude account | `settings.json` has no `vertex`: Claude Code used its own sign-in (step 4) |

## Options

Set in `settings.json` `env` (or the core's environment):

| Variable | What it does |
|:--|:--|
| `AETHER_CLAUDE` | The path of `claude` |
| `AETHER_CLAUDE_MODEL` | The model (`--model`), e.g. one your project has enabled |
| `AETHER_CLAUDE_PERMISSION` | Claude Code's permission mode (default `acceptEdits`: edits without asking, no shell without asking) |

In a workspace the person trusts (`aether trust`), Claude Code also loads the folder's own settings, hooks and MCP servers; elsewhere it
starts with `--setting-sources user --strict-mcp-config` ([spec/custom.md](../../../../spec/custom.md#safe-by-default)).
