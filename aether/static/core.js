// AetherRSI shell: the conversation (left), 📋 Tasks and 📂 Files (right), the composer (bottom).
// Extensions run in sandboxed iframes and talk to this page only through postMessage (spec/v0.1.md §3).
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k.startsWith("on") ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const S = { info: null, rev: -1, dest: null, quotes: JSON.parse(localStorage.aetherQuotes || "[]"), inject: null, tab: localStorage.aetherTab || "tasks",
  dir: "", open: null, frame: null };

async function api(path, body) {   // relative path: works under a proxy prefix too
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Aether": "1" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---- composer: destination, quotes (@n), inject ----
function saveQuotes() { localStorage.aetherQuotes = JSON.stringify(S.quotes); drawChips(); }
function addQuote(q) {
  const n = Math.max(0, ...S.quotes.map((x) => x.n)) + 1;   // numbers never shift, so @n in the text stays valid
  S.quotes.push({ ...q, n }); saveQuotes();
}
function insertAt(n) {
  const ta = $("#say"), a = ta.selectionStart, pre = ta.value.slice(0, a), post = ta.value.slice(ta.selectionEnd);
  const ins = `${pre && !/\s$/.test(pre) ? " " : ""}@${n} `;
  ta.value = pre + ins + post; ta.focus(); ta.selectionStart = ta.selectionEnd = a + ins.length; localStorage.aetherDraft = ta.value;
}
function chip(label, off, extra = {}) {
  const c = el("span", { class: `chip ${extra.cls || ""}`, title: extra.title || label }, extra.at ? el("b", { class: "at", title: `Insert @${extra.at}`, onclick: () => insertAt(extra.at) }, `@${extra.at}`) : null,
    el("span", {}, label), el("button", { type: "button", "aria-label": "Remove", onclick: off }, "✕"));
  return c;
}
function drawChips() {
  const kids = [];
  if (S.dest) kids.push(chip(`📨 To: ${S.dest.title}`, () => setDest(null), { cls: "dest" }));
  if (S.inject) kids.push(chip(`↪ Inject into: ${S.inject.label}`, () => { S.inject = null; drawChips(); }, { cls: "dest" }));
  S.quotes.forEach((q, i) => kids.push(chip(q.label, () => { S.quotes.splice(i, 1); saveQuotes(); }, { at: q.n, title: q.text || q.label })));
  $("#chips").replaceChildren(...kids);
  $("#chips").hidden = !kids.length;
}
function setDest(t) {
  S.dest = t; S.inject = null;
  history.replaceState(null, "", t ? `#task=${encodeURIComponent(t.id)}` : location.pathname + location.search);
  drawChips(); refresh(true); post("dest", { task: t });
}
async function send(e) {
  e && e.preventDefault();
  const ta = $("#say"), text = ta.value.trim();
  if (!text) return ta.focus();
  const body = { text, agent: $("#agent").value };
  if (S.inject) body.inject = S.inject.job;
  else { if (S.dest) body.task = S.dest.id; body.quotes = S.quotes; }
  $("#send").disabled = true;
  try {
    const r = await api("api/send", body);
    ta.value = ""; localStorage.aetherDraft = "";
    if (!S.inject) { S.quotes = []; saveQuotes(); }
    S.inject = null;
    if (r.task && (!S.dest || S.dest.id !== r.task.id)) setDest(r.task); else { drawChips(); refresh(true); }
  } catch (err) { alert(err.message); } finally { $("#send").disabled = false; }
}

// ---- conversation ----
const when = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function jobCard(j) {
  const agent = (S.info.agents.find((a) => a.id === j.agent) || { label: j.agent }).label;
  const live = j.state === "queued" || j.state === "running";
  const st = j.state === "queued" ? `queued #${j.pos || "?"}` : j.state === "running" ? `running ${Math.round(Date.now() / 1000 - j.started)}s` : j.state;
  const lines = j.lines.length ? el("ol", {}, ...j.lines.slice(live ? -8 : 0).map((l) => el("li", {}, l))) : null;
  const canInject = j.state === "running" && (S.info.agents.find((a) => a.id === j.agent) || {}).inject;
  return el("article", { class: "job", "data-id": j.id },
    el("div", { class: "top" }, el("span", {}, when(j.ts)), el("span", {}, agent), el("span", { class: `st ${j.state}` }, st), el("span", { class: "grow" }),
      j.cost != null ? el("span", {}, `$${j.cost.toFixed(3)}`) : null,
      canInject ? el("button", { type: "button", title: "Add to this running conversation", onclick: () => { S.inject = { job: j.id, label: j.text.slice(0, 40) }; drawChips(); $("#say").focus(); } }, "↪ Inject") : null,
      live ? el("button", { type: "button", onclick: () => api(`api/jobs/${j.id}/stop`, {}).then(() => refresh(true)) }, "⏹ Stop") : null),
    el("div", { class: "text" }, j.text),
    j.prompt !== j.text ? el("details", { class: "qs" }, el("summary", {}, "prompt with quotes"), el("pre", { style: "white-space:pre-wrap" }, j.prompt)) : null,
    lines && !live ? el("details", {}, el("summary", { class: "qs" }, `${j.lines.length} steps`), lines) : lines,
    j.reply ? el("div", { class: "reply" }, j.reply) : null,
    j.error ? el("div", { class: "err" }, j.error) : null);
}
async function drawLog() {
  const log = $("#log"), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const r = await api(`api/jobs${S.dest ? `?task=${encodeURIComponent(S.dest.id)}` : ""}`);
  if (S.dest && r.task && r.task.title !== S.dest.title) { S.dest = r.task; drawChips(); }
  log.replaceChildren(...(r.jobs.length ? r.jobs.map(jobCard) : [el("p", { class: "empty" }, S.dest ? "No messages for this task yet." : "Send a message to start. Each message becomes a task; pick a task on the right to continue it.")]));
  if (atEnd) log.scrollTop = log.scrollHeight;
  return r.jobs.some((j) => j.state === "running");
}

// ---- 📋 Tasks (in progress only) ----
async function drawTasks() {
  const ts = await api("api/tasks");
  $("#pane-tasks").replaceChildren(ts.length ? el("ul", { class: "list" }, ...ts.map((t) => el("li", { class: S.dest && S.dest.id === t.id ? "cur" : "" },
    el("span", { class: "name", title: "Open this task's conversation", onclick: () => setDest(t) }, `📋 ${t.title}`),
    el("button", { type: "button", title: "Mark done", onclick: async () => { await api(`api/tasks/${t.id}`, { status: "done" }); if (S.dest && S.dest.id === t.id) setDest(null); else refresh(true); } }, "✓ Done"))))
    : el("p", { class: "muted" }, "No tasks in progress."));
}

// ---- 📂 Files: the tree, previews and apps (iframes) ----
function post(type, data = {}) { if (S.frame && S.frame.contentWindow) S.frame.contentWindow.postMessage({ aether: S.info && S.info.protocol, type, ...data }, "*"); }
const extOf = (name) => (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
const fileUrl = (p) => `files/${p.split("/").map(encodeURIComponent).join("/")}`;
async function drawFiles() {
  const pane = $("#pane-files");
  if (S.open) return drawViewer(pane);
  let r;
  try { r = await api(`api/files?path=${encodeURIComponent(S.dir)}`); } catch (err) { S.dir = ""; return pane.replaceChildren(el("p", { class: "muted" }, err.message)); }
  const parts = r.path ? r.path.split("/") : [];
  const crumbs = el("div", { class: "crumbs" }, el("a", { onclick: () => { S.dir = ""; drawFiles(); } }, `📂 ${S.info.workspace}`),
    ...parts.flatMap((p, i) => ["/", el("a", { onclick: () => { S.dir = parts.slice(0, i + 1).join("/"); drawFiles(); } }, p)]),
    el("span", { style: "flex:1" }), r.app ? el("button", { type: "button", onclick: () => openApp(r.path, r.app) }, `▶ Open ${r.app.label}`) : null,
    r.path ? el("button", { type: "button", title: "Quote this folder", onclick: () => quoteFolder(r.path, r.app) }, "📎 Quote") : null);
  const rows = r.items.map((it) => el("li", {},
    el("span", { class: "name", onclick: () => (it.dir ? ((S.dir = it.path), drawFiles()) : openFile(it.path)) }, `${it.app ? "🧩" : it.dir ? "📁" : "📄"} ${it.name}`),
    it.app ? el("button", { type: "button", onclick: () => openApp(it.path, it.app) }, "▶ Open") : null));
  pane.replaceChildren(crumbs, rows.length ? el("ul", { class: "list" }, ...rows) : el("p", { class: "muted" }, "Empty folder."));
}
function quoteFolder(path, app) { addQuote({ label: `${app ? "🧩" : "📁"} ${path}/`, text: "", path, rules: app && app.rules ? `${path}/${app.rules}` : "" }); }
function openFile(path) {
  const p = S.info.previews.find((x) => x.match.includes(extOf(path)));
  S.open = { kind: "file", path, preview: p }; drawFiles();
}
function openApp(path, app) { S.open = { kind: "app", path, app }; drawFiles(); }
function drawViewer(pane) {
  const o = S.open, name = o.path.split("/").pop();
  const bar = el("div", { class: "bar" }, el("button", { type: "button", onclick: () => { S.open = null; S.frame = null; drawFiles(); } }, "← Back"),
    el("b", { title: o.path }, o.kind === "app" ? `🧩 ${o.app.label}` : `📄 ${o.path}`),
    el("button", { type: "button", title: "Quote this file / folder", onclick: () => (o.kind === "app" ? quoteFolder(o.path, o.app) : addQuote({ label: `📄 ${o.path}`, text: "", path: o.path })) }, "📎 Quote"));
  if (o.kind === "file" && !o.preview) { S.frame = null; return pane.replaceChildren(el("div", { class: "viewer" }, bar, el("p", { class: "none" }, `No preview extension for “${extOf(name) || name}”. Quote it to hand it to the agent.`))); }
  const src = o.kind === "app" ? fileUrl(`${o.path}/${o.app.entry}`) : `x/${o.preview.id}/${o.preview.entry}`;
  const f = el("iframe", { src, sandbox: "allow-scripts", title: name });
  f.addEventListener("load", async () => {
    post("theme", { dark: matchMedia("(prefers-color-scheme: dark)").matches });
    if (o.kind === "file") { try { post("open", { path: o.path, name, text: (await api(`api/read?path=${encodeURIComponent(o.path)}`)).text }); } catch (err) { post("open", { path: o.path, name, error: err.message }); } }
    else post("open", { path: o.path, name, folder: true });
    post("dest", { task: S.dest });
  });
  S.frame = f;
  pane.replaceChildren(el("div", { class: "viewer" }, bar, f));
}
window.addEventListener("message", async (e) => {   // only from the frame we opened
  if (!S.frame || e.source !== S.frame.contentWindow || !e.data || typeof e.data.type !== "string") return;
  const d = e.data, o = S.open;
  if (d.type === "quote.add") addQuote({ label: `${o.kind === "app" ? "🧩" : "📄"} ${o.path}${d.label ? ` · ${String(d.label).slice(0, 60)}` : ""}`, text: String(d.text || "").slice(0, 20000), path: o.path, rules: o.kind === "app" && o.app.rules ? `${o.path}/${o.app.rules}` : "" });
  else if (d.type === "send") { const ta = $("#say"); ta.value = (ta.value ? ta.value + "\n" : "") + String(d.text || ""); localStorage.aetherDraft = ta.value; ta.focus(); }
  else if (d.type === "task.open") { const t = (await api("api/tasks")).find((x) => x.id === d.id); if (t) setDest(t); }
  else if (d.type === "read") {   // an app reads files of its own folder
    const rel = String(d.path || "");
    const reply = (x) => post("reply", { id: d.id, ...x });
    if (o.kind !== "app" || !rel || rel.startsWith("/") || rel.split("/").includes("..")) return reply({ ok: false, error: "apps may read only inside their folder" });
    try { reply({ ok: true, text: (await api(`api/read?path=${encodeURIComponent(`${o.path}/${rel}`)}`)).text }); } catch (err) { reply({ ok: false, error: err.message }); }
  }
});

// ---- tabs, polling, start ----
function setTab(t) {
  S.tab = t; localStorage.aetherTab = t;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $("#pane-tasks").hidden = t !== "tasks"; $("#pane-files").hidden = t !== "files";
  if (t === "files") drawFiles(); else drawTasks();
}
let busy = false;
async function refresh(force) {
  if (busy) return;
  busy = true;
  try {
    const { rev } = await api("api/poll");
    if (force || rev !== S.rev) {
      S.rev = rev;
      const running = await drawLog();
      if (S.tab === "tasks") await drawTasks();
      if (S.open) post("rev", { rev });
      if (running) S.rev = -1;   // keep the elapsed seconds moving
    }
  } catch (err) { console.error(err); } finally { busy = false; }
}
async function start() {
  S.info = await api("api/info");
  $("#ws").textContent = `📂 ${S.info.workspace}`;
  $("#lock").textContent = S.info.locked ? "🔒 core locked" : "🔓 core unlocked";
  $("#lock").title = S.info.locked ? "Agents may not write to the core; the file tree stays inside the workspace." : "Unlocked by config.json (core_locked: false).";
  if (S.info.errors.length) { $("#warn").hidden = false; $("#warn").textContent = `⚠ ${S.info.errors.length} extension(s) skipped`; $("#warn").title = S.info.errors.join("\n"); }
  const want = localStorage.aetherAgent;
  $("#agent").replaceChildren(...S.info.agents.map((a) => el("option", { value: a.id, ...(a.disabled ? { disabled: "", title: a.disabled } : {}) }, `${a.label}${a.disabled ? " (off)" : ""}`)));
  $("#agent").value = S.info.agents.some((a) => a.id === want && !a.disabled) ? want : S.info.agent;
  $("#agent").addEventListener("change", () => (localStorage.aetherAgent = $("#agent").value));
  $("#say").value = localStorage.aetherDraft || "";
  $("#say").addEventListener("input", () => (localStorage.aetherDraft = $("#say").value));
  $("#say").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e); });
  $("#composer").addEventListener("submit", send);
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  const m = location.hash.match(/task=([^&]+)/);
  if (m) S.dest = (await api("api/tasks")).find((t) => t.id === decodeURIComponent(m[1])) || null;
  drawChips(); setTab(S.tab); await refresh(true);
  setInterval(() => { if (!document.hidden) refresh(false); }, 1000);
}
start();
