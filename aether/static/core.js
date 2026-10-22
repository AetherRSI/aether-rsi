// AetherRSI shell: ① 📋 Tasks (🧭 All · the queue bundled by session · 🕘 Past) over the conversation of one task (or 🧭 All) · ② the panel (📂 Files) · ③ the composer.
// Survives a reload: the open task is the URL's #task=<id>, the draft, quotes, the line between tasks and conversation, panel width and open folders live in localStorage.
// Previews and apps run in sandboxed iframes and talk to this page only through postMessage (spec/v0.1.md §3).
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) k.startsWith("on") ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  e.append(...kids.flat().filter((k) => k != null && k !== false));
  return e;
};
const LS = localStorage, POLL = 1000;
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\//;   // a server on this machine (the same hosts as aether.json "url")
const short = (s, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);
let INFO = null, DEST = null, AGENT = "", REV = -1, RELOADING = false;   // RELOADING: --reload holds the queue to swap in new code
let QUOTES = JSON.parse(LS.aetherQuotes || "[]");   // [{n?, label, text, path?, rules?, task?, job?, inject?|append?|edit?, tid?}]

async function api(path, body) {   // relative paths: the same behind a proxy prefix
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Aether": "1" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { body: j });
  return j;
}
// Another session's running job is editing a file this message quotes (409 conflict): the person approves before it is sent (2026-10-18
// 「他タスクが編集中のタスクを修正しようとすると、メッセージ送信で、ユーザ認証を取る」). Approved → the same request again with confirm: true
function approve(hits, what) {
  const d = $("#okdlg");
  $("#okwhat").textContent = what;
  $("#oklist").replaceChildren(...hits.map((h) => el("li", {}, el("b", {}, `▶ ${h.title || h.task}`), " is editing ", ...h.paths.map((x, i) => [i ? ", " : "", el("code", {}, x)]))));
  return new Promise((done) => {
    d.onclose = () => done(d.returnValue === "ok");
    d.returnValue = ""; d.showModal(); $("#okno").focus();   // the safe choice has the focus
  });
}
async function approved(path, body, what) {   // api() with the approval step in between
  try { return await api(path, body); }
  catch (e) {
    if (!(e.body && e.body.conflict)) throw e;
    if (!(await approve(e.body.conflict, what))) return null;   // null: the person said no ―― nothing was sent
    return api(path, { ...body, confirm: true });
  }
}
const agentOf = (id) => INFO.agents.find((a) => a.id === id) || { id, label: id || "agent" };
const agentMark = (id) => { const a = agentOf(id); return a.icon ? el("img", { class: "amark", src: a.icon, alt: a.label, title: a.label }) : a.label; };   // the manifest's icon where room is short, else the label
const agentBadge = (id) => { const a = agentOf(id); return a.icon ? [agentMark(id), ` ${a.label.replace(/^\P{L}+/u, "")}`] : [a.label]; };   // icon + name, the label's emoji dropped (2026-10-22 「💎 Gemini Argon is working これも アイコンは Gemini や Claude のアイコンにする」)
async function copyText(text, btn) {   // 📋 → ✅ (or ❌) for a moment
  let ok = true;
  try { await navigator.clipboard.writeText(text); }
  catch {   // no clipboard API (an http origin that is not localhost): the old way
    const t = el("textarea", { readonly: "", style: "position:fixed;opacity:0" }); t.value = text; document.body.append(t); t.select();
    ok = document.execCommand("copy"); t.remove();
  }
  btn.dataset.icon ||= btn.textContent; btn.textContent = ok ? "✅" : "❌";
  clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = btn.dataset.icon; }, 1500);
}
const copyBtn = (get, tip, attrs = {}) => el("button", { type: "button", class: "copy", title: tip, "aria-label": tip, ...attrs,
  onclick: (e) => { e.stopPropagation(); copyText(get(), e.currentTarget); } }, "📋");

// ---------- ③ composer: destination, quotes (@n), inject ----------
const target = (q) => q.inject || q.append || q.edit;   // the one job what you send goes to: ↪ into a running one, ➕ / ✎ onto a waiting one
const mentionable = (q) => !target(q);
const AT = /(^|[^\w@])@(\d+)(?!\d)/g;
const atOf = (n) => new RegExp(`(^|[^\\w@])@${n}(?!\\d)`, "g");
function numbered(qs) { let top = Math.max(0, ...qs.map((q) => q.n || 0)); return qs.map((q) => (!mentionable(q) || q.n ? q : { ...q, n: ++top })); }   // numbers never shift, so @n in the text stays valid
const quoteName = (q) => (q.inject ? `↪ Inject into: ${q.label}` : q.append ? `➕ Add to the queued: ${q.label}` : q.edit ? `✎ Edit the queued: ${q.label}`
  : q.job ? `🧭 Previous: ${q.label}` : q.task ? `📋 ${q.label}` : q.label);
function setQuotes(qs) {
  qs = numbered(qs);
  const gone = QUOTES.filter((q) => q.n && !qs.some((x) => x.n === q.n)), ta = $("#say");   // a removed chip's @n becomes its name
  const v = gone.reduce((s, q) => s.replace(atOf(q.n), (_, p) => `${p}"${q.label}"`), ta.value);
  if (v !== ta.value) { ta.value = LS.aetherDraft = v; growSay(); }
  QUOTES = qs; LS.aetherQuotes = JSON.stringify(qs); drawDest();
}
function addQuotes(qs) {   // the same thing is quoted once (and keeps its number)
  const same = (q, x) => (q.task || x.task ? q.task === x.task : q.text === x.text && q.label === x.label);
  setQuotes([...QUOTES.filter((q) => !qs.some((x) => same(q, x))), ...qs.map((x) => { const o = QUOTES.find((q) => same(q, x)); return o && o.n ? { ...x, n: o.n } : x; })]);
  $("#say").focus();
}
function chip(text, tip, off, cls, n) {
  const x = el("button", { type: "button", "aria-label": tip, onclick: off }, "✕");
  if (!n) return el("span", { class: cls, title: text }, el("span", {}, text), x);
  const at = el("b", { class: "at", role: "button", tabindex: "0", "aria-label": `Insert @${n}`, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertAt(n); } } }, `@${n}`);
  return el("span", { class: `${cls} mention`, title: `${text}\nClick to insert @${n} at the cursor`, onclick: (e) => { if (!e.target.closest("button")) insertAt(n); } }, at, el("span", {}, text), x);
}
function drawDest() {
  const d = $("#dest");
  d.hidden = !DEST && !QUOTES.length;
  d.replaceChildren(...(DEST ? [chip(`📨 To: ${DEST.title}`, "Remove the destination (back to 🧭 All)", () => openView(null), "chip")] : []),
    ...QUOTES.map((q, i) => chip(quoteName(q), q.edit ? "Stop editing (the queued message stays as it was)" : "Remove the quote", () => setQuotes(QUOTES.filter((_, k) => k !== i)),
      q.inject ? "chip quote inject" : q.append || q.edit ? "chip quote queued" : "chip quote", q.n || 0)));
}
function growSay(max = 6) {   // grow with the text; past `max` lines it scrolls inside
  const ta = $("#say"); if (!ta.offsetParent) return;
  const cs = getComputedStyle(ta), bd = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const lim = parseFloat(cs.lineHeight) * max + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + bd, st = ta.scrollTop;
  ta.style.height = "auto"; const h = ta.scrollHeight + bd;
  ta.style.height = `${Math.min(h, lim)}px`; ta.style.overflowY = h > lim + 1 ? "auto" : "hidden";
  ta.scrollTop = document.activeElement === ta && ta.selectionEnd === ta.value.length ? ta.scrollHeight : st;
}
function insertAt(n, drop = 0) {   // "@n " at the cursor (drop: the @ typed to open the menu)
  const ta = $("#say"), v = ta.value;
  let a = Math.max(0, ta.selectionStart - drop), b = ta.selectionEnd;
  if (document.activeElement !== ta && !drop && a === 0 && b === 0 && v) a = b = v.length;
  const pre = v.slice(0, a), post = v.slice(b), ins = `${/[\w@]$/.test(pre) ? " " : ""}@${n}${/^\s/.test(post) ? "" : " "}`;
  ta.value = LS.aetherDraft = pre + ins + post;
  ta.focus(); ta.selectionStart = ta.selectionEnd = a + ins.length;
  growSay(); closeAt();
}
function addJob(j) {   // ↪ Quote on a finished job: continue that task, with the instruction (and the head of the reply) quoted
  if ((j.task || "") !== ((DEST && DEST.id) || "")) openView({ id: j.task, title: j.title || j.task });
  const flat = (s) => String(s || "").replace(/\s+/g, " ").trim(), text = flat(j.text), reply = flat(j.reply);
  const body = `${short(text, 400)}${reply ? ` → reply: ${short(reply, 200)}` : ""}`;
  const o = QUOTES.find((q) => q.job === j.id);
  setQuotes([...QUOTES.filter((q) => q.job !== j.id && !target(q)), { label: short(text), text: body, job: j.id, ...(o && o.n ? { n: o.n } : {}) }]);
  showLog(); $("#say").focus();
}
function addInject(j) {   // ↪ Quote on a running job: what you send next goes into that conversation
  if ((j.task || "") !== ((DEST && DEST.id) || "")) openView({ id: j.task, title: j.title || j.task });
  setQuotes([...QUOTES.filter((q) => !target(q)), { label: short(j.title || j.text), text: "", inject: j.id, tid: j.task }]);
  showLog(); $("#say").focus();
}
function addQueued(j) {   // 📎 on a waiting job: what you send is added to it (it keeps its place in the queue)
  if ((j.task || "") !== ((DEST && DEST.id) || "")) openView({ id: j.task, title: j.title || j.task });
  setQuotes([...QUOTES.filter((q) => !target(q)), { label: short(String(j.text || "").trim().split("\n")[0] || j.title), text: "", append: j.id, tid: j.task }]);
  showLog(); $("#say").focus();
}
function editJob(j) {   // ✎ on a waiting job: ③ gets its text and quotes back; sending rewrites it in place
  const ta = $("#say"), text = String(j.text || "");
  if (ta.value.trim() && ta.value.trim() !== text.trim() && !confirm("Replace what is in ③ with this queued message to edit it?")) return;
  if ((j.task || "") !== ((DEST && DEST.id) || "")) openView({ id: j.task, title: j.title || j.task });
  const qs = quotesOf(j.prompt || "").map((q) => { const s = srcOf(q); return { label: q.label, text: q.text, ...(q.at ? { n: q.at } : {}), ...(q.rules ? { rules: q.rules } : {}), ...(s ? { path: s.path } : {}) }; });
  QUOTES = []; ta.value = LS.aetherDraft = text;   // not setQuotes: the chips that leave must not rewrite the @n of the text coming in
  setQuotes([{ label: short(text.trim().split("\n")[0] || j.title), text: "", edit: j.id, tid: j.task }, ...qs]);
  growSay(); showLog(); ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
}

// @ menu: ↑↓ to pick, Enter/Tab to insert, Esc to close (not while composing with an IME)
let atSel = 0;
function closeAt() { $("#atmenu").hidden = true; $("#say").removeAttribute("aria-activedescendant"); }
function drawAt() {
  const ta = $("#say"), c = ta.selectionStart, v = ta.value, qs = QUOTES.filter((q) => q.n), m = $("#atmenu");
  if (!qs.length || c !== ta.selectionEnd || !/[@＠]/.test(v[c - 1] || "") || /[\w@＠]/.test(v[c - 2] || "")) return closeAt();
  atSel = Math.min(atSel, qs.length - 1);
  m.replaceChildren(...qs.map((q, k) => el("button", { type: "button", role: "option", id: `at-${q.n}`, "aria-selected": String(k === atSel), "data-n": String(q.n), title: q.text,
    onmousedown: (e) => e.preventDefault(), onclick: () => insertAt(q.n, 1) }, el("b", {}, `@${q.n}`), el("span", {}, quoteName(q)))));
  m.hidden = false;
  ta.setAttribute("aria-activedescendant", `at-${qs[atSel].n}`);
}

// ---------- send ----------
// The pick is the core's default (config.json "agent"), not this browser's: senders that name no agent (spawn.py, another tab or address)
// get the same one (2026-10-22 「GeminiになっているのにClaudeCOdeがはいったよ」 ―― it lived in localStorage and the core still said claude-code)
async function setAgent(id, save = false) {
  const ok = INFO.agents.filter((a) => !a.disabled);
  AGENT = ok.some((a) => a.id === id) ? id : INFO.agent;
  $("#agents").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.agent === AGENT)));
  $("#send .agent").replaceChildren(agentMark(AGENT));   // arrow_upward + the agent's logo (2026-10-22 「Sendボタンは、「↑」とAgentロゴへ」「Material Iconのarrow_upwardにして」)
  $("#send").title = `Send to ${agentOf(AGENT).label} (▾ to switch)`;
  $("#send").setAttribute("aria-label", $("#send").title);
  if (save && AGENT !== INFO.agent) {
    try { INFO.agent = (await api("api/config", { agent: AGENT })).agent; }
    catch (e) { bubble("bot", `❌ Could not save the agent choice: ${e.message}`); }
  }
}
async function pullAgent() {   // back to this tab: another tab (or address) may have picked since
  try { const i = await api("api/info"); INFO.agent = i.agent; if (i.agent !== AGENT) setAgent(i.agent); } catch (e) { console.error(e); }
}
const sendMenu = (open) => { $("#send-menu").hidden = !open; $("#send-more").setAttribute("aria-expanded", String(open)); if (open) $("#send-menu button").focus(); };
async function send(mode = "") {
  const ta = $("#say"), said = ta.value.trim();
  if (!said) return ta.focus();
  const inj = QUOTES.find((q) => q.inject), onto = QUOTES.find((q) => q.append || q.edit), qs = QUOTES.filter(mentionable), was = QUOTES;
  ta.value = ""; growSay(); delete LS.aetherDraft; closeAt(); setQuotes([]);
  const me = meBubble({ text: said, prompt: compose(said, qs) }, null, inj ? `↪ Inject: ${inj.label}` : onto ? quoteName(onto) : "");
  const b = bubble("bot", el("div", { class: "step" }, el("span", { class: "spin" }), inj ? "↪ Injecting into the running conversation"
    : onto ? (onto.edit ? "✎ Rewriting the queued message" : "➕ Adding to the queued message") : { first: "⏫ Priority sending", parallel: "⚡ Parallel sending" }[mode] || "Sending"));
  me.classList.add("pending"); b.classList.add("pending");
  try {
    const r = await approved("api/send", inj ? { text: said, inject: inj.inject } : onto ? { text: said, quotes: qs, ...(onto.edit ? { edit: onto.edit } : { append: onto.append }) }
      : { text: said, task: DEST ? DEST.id : "", agent: AGENT, quotes: qs, first: mode === "first", parallel: mode === "parallel" },
      mode === "parallel" ? "⚡ Parallel send runs it now, beside that job." : "This message quotes it too: two agents may change the same files.");
    if (!r) {   // not approved: the message comes back to ③ as it was
      me.remove(); b.remove();
      ta.value = LS.aetherDraft = said; QUOTES = []; setQuotes(was); growSay(); ta.focus();
      return;
    }
    if (inj || r.note) {   // no job of its own (or not the one asked for): keep the pair until the view changes
      me.classList.remove("pending"); b.classList.remove("pending");
      stick(() => b.replaceChildren(el("div", { class: "step" }, r.injected && inj ? "📨 Injected. The agent reads it after its current step and carries on in the same job (progress and reply above)." : `↪ ${r.note}`)));
      return inj ? null : sync();
    }
    if (r.task && r.task.id !== (DEST && DEST.id)) return openView(r.task);   // a new task: move to its conversation
    sync(true);
  } catch (e) {
    me.classList.remove("pending"); b.classList.remove("pending");
    if (onto && onto.edit) { ta.value = LS.aetherDraft = said; QUOTES = []; setQuotes(was.filter((q) => !q.edit)); growSay(); }   // the edit did not land: the text comes back (as a new message now)
    stick(() => b.replaceChildren(el("div", { class: "err" }, `❌ ${e.message}`)));
  }
}
function compose(text, qs) {   // what the server will build (runner.compose), so the pending bubble already shows its chips
  return qs.length ? `${text}\n\n---\nQuoted:\n${qs.map((q) => `@${q.n} ${q.label}${q.text ? `\n> ${q.text}` : ""}`).join("\n\n")}` : text;
}

// ---------- ① conversation ----------
const atEnd = () => { const l = $("#log"); return l.scrollHeight - l.scrollTop - l.clientHeight < 40; };
const toEnd = () => { const l = $("#log"); l.scrollTop = l.scrollHeight; };
function stick(fn) { const end = atEnd(); fn(); if (end) toEnd(); }   // follow the bottom only when it is in view
function bubble(cls, ...kids) { const b = el("div", { class: `msg ${cls}` }, ...kids); stick(() => $("#log").append(b)); return b; }
function quotesOf(prompt) {   // the chips of a sent message, read back from its prompt ("@n label" + "> " lines)
  const i = prompt.indexOf("\n\n---\nQuoted:\n");
  if (i < 0) return [];
  return prompt.slice(i + 14).split(/\n\n(?=@)/).map((blk) => {
    const [head, ...rest] = blk.split("\n"), m = head.match(/^@(\d+|-) (.*)$/);
    if (!m) return null;
    const app = m[2].match(/ \(an app folder: read (.*) first and follow it\)$/), label = app ? m[2].slice(0, app.index) : m[2];
    return { at: +m[1] || 0, label, text: rest.map((l) => l.replace(/^> ?/, "")).join("\n"), ...(app ? { rules: app[1] } : {}) };
  }).filter(Boolean);
}
function show(src) {   // open the panel on the quoted thing
  if ($("#main").classList.contains("closed")) setPane("open");
  if (src.path != null) { setTab("files"); (src.dir ? openDir(src.path) : openFile(src.path)).then(() => reveal(src.path)).catch(() => {}); }
  else if (src.task) { foldTasks(false); HILITE = src.task; drawTasks().then(() => document.querySelector("#board .qrow.hit")?.scrollIntoView({ block: "nearest" })); }
}
function srcOf(q) {   // label → where it came from (📄 path · …, 📁 path/, 🧩 path/)
  const m = q.label.match(/^(📄|📁|🧩) (.+?)\/?(?: · .*)?$/);
  return m ? { path: m[2], dir: m[1] !== "📄" } : null;
}
function meBubble(j, task, head = "", put = true) {
  const qs = quotesOf(j.prompt || ""), src = (label, tip, go) => el("button", { type: "button", class: "src", title: tip, onclick: go }, label);
  const mk = (q, inline) => src(`${q.at && !inline ? `@${q.at} ` : ""}${short(q.label, 40)}`, `Click to show it on the right and quote it again: ${q.label}`, () => {
    const s = srcOf(q); if (s) show(s);
    addQuotes([{ label: q.label, text: q.text, ...(s ? { path: s.path } : {}) }]);
  });
  const refs = new Map(qs.filter((q) => q.at).map((q) => [q.at, q])), body = String(j.text || ""), parts = [];
  let last = 0;
  for (const m of body.matchAll(AT)) {   // @n in the text becomes the chip with that number
    const q = refs.get(+m[2]); if (!q) continue;
    const at = m.index + m[1].length, x = mk(q, true);
    x.classList.add("at"); x.title = `@${m[2]} ―― ${x.title}`;
    parts.push(body.slice(last, at), x); last = at + 1 + m[2].length;
  }
  parts.push(body.slice(last));
  const b = el("div", { class: "msg me" },
    task ? src(`📨 ${task.title}`, "Click to open this task", () => openView(task)) : head ? el("div", {}, head) : null,
    el("div", {}, ...parts),
    qs.length ? el("div", { class: "srcs" }, ...qs.map((q) => mk(q, false))) : null,
    body.trim() ? copyBtn(() => body, "Copy this message (without its quotes)", { class: "copy mcopy" }) : null);
  if (put) { stick(() => $("#log").append(b)); toEnd(); }
  return b;
}
const secs = (x) => { const v = Math.max(0, Math.round(x)); return v < 60 ? `${v}s` : `${v}s (${Math.floor(v / 60)}m ${v % 60}s)`; };
const upTime = (j) => (j.started ? ` · ${secs(Date.now() / 1000 - j.started)} since start` : "");
const ENDED = ["done", "failed", "stopped"];
// What one job can do, in one order for both places (2026-10-18 「Taskの端に…を出し、メニューで…メッセージの中も合わせる（アイコンのみ）」):
// 📎 quote always; waiting: ✎ edit, ⚡ parallel send; running or waiting: ⏹ stop. The … menu of a row in 📋 Tasks shows icon and words, a bubble the icons only
function jobActs(j) {
  const quote = ENDED.includes(j.state) ? ["prompt", "Quote this instruction in ③ ―― what you send continues the same task", () => addJob(j)]
    : j.state === "queued" ? ["append", "Quote this queued message in ③ ―― what you send is added to it (it keeps its place)", () => addQueued(j)]
    : agentOf(j.agent).inject ? ["inject", "Quote this conversation in ③ ―― what you send goes into it right away", () => addInject(j)]
    : ["prompt", "Quote this instruction in ③ ―― what you send runs next in the same task", () => addJob(j)];   // an agent that takes no inject
  return [{ how: "quote", kind: quote[0], icon: "📎", label: "Quote", tip: quote[1], go: quote[2] },
    ...(j.state === "queued" ? [{ how: "edit", icon: "✎", label: "Edit", tip: "Edit this queued message in ③ ―― sending rewrites it in place", go: () => editJob(j) }] : []),
    ...(j.state === "queued" ? [{ how: "parallel", icon: "⚡", label: "Parallel send", tip: "Run it now as a task of its own (a new session), instead of waiting for this session's running task",
      go: async () => { const r = await approved(`api/jobs/${j.id}/parallel`, {}, "⚡ Parallel send runs it now, beside that job."); if (r && r.task) openView(r.task); return r; } }] : []),
    ...(ENDED.includes(j.state) ? [] : [{ how: "stop", icon: "⏹", label: "Stop", tip: "Stop this job", go: () => api(`api/jobs/${j.id}/stop`, {}), once: true }])];
}
function haltBar(j) {
  const lock = (on) => bar.querySelectorAll("button").forEach((y) => { y.disabled = on; });
  const btn = (a) => el("button", { type: "button", class: "hicon", "data-how": a.how, "data-kind": a.kind || null, title: a.tip, "aria-label": `${a.label}: ${a.tip}`, onclick: async (e) => {   // once: the bar stays locked after it worked (⏹ Stop); 📎 can be pressed again and again
    e.stopPropagation();
    if (a.once || a.how === "parallel") lock(true);
    try { if ((await a.go()) === null) return lock(false); if (a.how === "stop") bar.append(el("span", { class: "step" }, "Stopping…")); }   // null: not approved
    catch (err) { bar.append(el("span", { class: "err" }, `❌ ${err.message}`)); lock(false); }
  } }, a.icon);
  const bar = el("div", { class: "halt" });
  if (j.state === "done" && j.reply) bar.append(copyBtn(() => j.reply, "Copy the reply (as Markdown)"));
  bar.append(...jobActs(j).map(btn));
  return bar;
}
// a step the agent cut short ends with …: click it for the whole text, again to close (2026-10-18 「Tasksのエージェントログ表示が省略されている、最後に「…」を出して、クリックで全部出すようにして」)
// as SoloGen v3 shows it: the … follows the text on the same line and the whole line is the switch (2026-10-18 「メッセージビューのエージェントログの出し方をSologenV3を参考に「…」を出して」)
const STEPOPEN = new Set();   // "<job>:<line>" kept open through redraws (a running job redraws at every step)
function stepLine(j, t, i) {
  const many = t.includes("\n"), full = (j.fulls || {})[i] || (many ? t : "");   // a line with breaks (older ones, other agents) shows its first line and … too
  if (many) t = t.split("\n")[0];
  if (!full) return el("div", { class: "step" }, t);
  const k = `${j.id}:${i}`, open = STEPOPEN.has(k);
  const btn = el("button", { type: "button", class: "more-btn", "aria-expanded": String(open), title: open ? "Close" : "Show the whole line", "aria-label": open ? "Close the whole line" : "Show the whole line" }, open ? "▲ Close" : "…");
  const row = el("div", { class: `step more${open ? " open" : ""}`, title: open ? "" : "Click for the whole line" }, open ? el("pre", { class: "full" }, full) : t, btn);
  row.addEventListener("click", (e) => {
    if (e.target.closest("a") || (open && e.target.closest("pre") && getSelection().toString())) return;   // a link, or copying from the whole text, does not fold it
    e.stopPropagation(); open ? STEPOPEN.delete(k) : STEPOPEN.add(k); stick(() => row.replaceWith(stepLine(j, t, i)));
  });
  return row;
}
function drawJob(j, b) {
  const kids = (j.lines || []).map((t, i) => stepLine(j, t, i));
  if (j.state === "queued" && RELOADING) kids.unshift(el("div", { class: "step" }, "🔁 The core swaps in its new code first (once nothing runs), then this starts"));
  if (j.state === "queued") kids.unshift(el("div", { class: "step" }, `⏳ Waiting for this session's running task${j.pos ? ` (#${j.pos} in the session)` : ""}`));
  else if (j.state === "running") kids.unshift(el("div", { class: "step" }, el("span", { class: "spin" }), ...agentBadge(j.agent), " is working", el("span", { class: "up" }, upTime(j))));
  else if (j.state === "done") kids.push(el("div", { class: "md" }, md(j.reply || "(no reply)")), j.cost != null ? el("div", { class: "step" }, `$${j.cost.toFixed(3)}`) : null);
  else if (j.state === "stopped") kids.push(el("div", { class: "step" }, "⏹ Stopped"));
  else kids.push(el("div", { class: "err" }, `❌ ${j.error || "Failed"}`));
  if (j.state !== "done" && j.error && j.state !== "failed") kids.push(el("div", { class: "err" }, j.error));
  kids.push(haltBar(j));
  b.replaceChildren(...kids.filter(Boolean));
}
const HELLO = "AetherRSI. Write what you want done and send it (⌘Enter). Each message becomes a task and its conversation opens here; click a row in 📋 Tasks above to continue a task (🕘 Past has the ones that ended). Each session runs one task at a time; different sessions run side by side.";
function setDest(t) {
  DEST = t ? { id: t.id, title: t.title } : null;
  if (QUOTES.some((q) => target(q) && q.tid !== (DEST && DEST.id))) setQuotes(QUOTES.filter((q) => !target(q) || q.tid === (DEST && DEST.id)));
  history.replaceState(null, "", DEST ? `#task=${encodeURIComponent(DEST.id)}` : location.pathname + location.search);
  drawDest(); post("dest", { task: DEST });
  drawTasks();
}
function openView(t) {
  if ((t && t.id) === (DEST && DEST.id) && $("#log").firstChild) return $("#say").focus();
  setDest(t); sync(true, true); $("#say").focus();
}
let SYNC = 0;
async function sync(force, fresh) {   // ① = the jobs of the open task (or the last 40 of all). Bubbles are redrawn only when their job changed
  const my = ++SYNC;
  const r = await api(`api/jobs${DEST ? `?task=${encodeURIComponent(DEST.id)}` : ""}`).catch(() => null);
  if (!r || my !== SYNC) return;
  const log = $("#log");
  if (DEST && !r.task) { bubble("bot", "⚠️ That task is gone (or the link is wrong). Showing 🧭 All."); return openView(null); }
  if (DEST && r.task.title !== DEST.title) { DEST.title = r.task.title; drawDest(); }
  log.querySelectorAll(".pending").forEach((x) => x.remove());
  const shown = [...log.querySelectorAll(".msg.bot[data-jid]")].map((x) => x.dataset.jid), ids = r.jobs.map((j) => j.id);
  if (fresh || shown.some((id, i) => ids[i] !== id)) {   // another view, or the order changed (priority send): draw from scratch
    log.replaceChildren();   // which view this is: the open row in 📋 Tasks (🧭 All or the task) and 📨 To: over ③ (2026-10-18: no breadcrumb over the messages)
    if (!DEST) bubble("bot hello", HELLO);
    else if (!r.jobs.length) bubble("bot", `📨 This is the conversation of “${DEST.title}”. No messages yet ―― what you send runs in this task's session.`);
  }
  for (const j of r.jobs) {
    let b = log.querySelector(`.msg.bot[data-jid="${j.id}"]`);
    if (!b) { b = bubble("bot"); b._me = meBubble(j, DEST ? null : { id: j.task, title: j.title }, "", false); log.insertBefore(b._me, b); b.dataset.jid = j.id; b.dataset.said = j.prompt; }
    else if (b.dataset.said !== j.prompt && b._me) { const nb = meBubble(j, DEST ? null : { id: j.task, title: j.title }, "", false); b._me.replaceWith(nb); b._me = nb; b.dataset.said = j.prompt; }   // ➕ / ✎ changed a queued message
    b._job = j;
    const key = JSON.stringify([j.state, j.pos, RELOADING && j.state === "queued", j.lines.length, Object.keys(j.fulls || {}).length, j.reply, j.error, j.cost]);   // fulls: whole texts can arrive later (filled in from the agent's transcript)
    if (key !== b.dataset.key) { if (b.dataset.key && ENDED.includes(j.state)) treeStale = true; b.dataset.key = key; stick(() => drawJob(j, b)); }
  }
  if (fresh) toEnd();
}
function tick() {   // the seconds move without redrawing (a redraw under the pointer would swallow the ⏹ click)
  tickQueue();
  document.querySelectorAll("#log .msg.bot[data-jid]").forEach((b) => { const up = b.querySelector(".up"); if (up && b._job) up.textContent = upTime(b._job); });
}

// Markdown for replies: headings, lists (nested by indent), tables, code, quotes, rules, **bold**, `code`, links. Text is escaped first
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function mdInline(s) {
  const codes = [];
  const h = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s（(])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
const MD_ROW = /^\s*\|.*\|\s*$/, MD_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/, MD_BLOCK = /^\s*(```|\|.*\|\s*$|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/, MD_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const mdEl = (tag, s) => { const e = el(tag); e.innerHTML = mdInline(s); return e; };
function mdTable(rows) {
  const cells = (r) => r.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());   // \| is a pipe inside a cell (GFM), not a column
  const sep = (r) => { const cs = cells(r); return cs.some((c) => c.includes("-")) && cs.every((c) => /^:?-+:?$/.test(c) || !c); };
  const head = rows.length > 1 && sep(rows[1]), align = head ? cells(rows[1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "")) : [];
  const t = el("table");
  rows.filter((r) => !sep(r)).forEach((r, k) => t.append(el("tr", {}, ...cells(r).map((c, ci) => { const td = mdEl(head && !k ? "th" : "td", c); if (align[ci]) td.style.textAlign = align[ci]; return td; }))));
  return el("div", { class: "mdtw" }, t);
}
function mdList(lines) {
  const out = document.createDocumentFragment(), stack = [];
  for (const l of lines) {
    const m = l.match(MD_ITEM), top = stack[stack.length - 1];
    if (!m) { const li = top && top.list.lastElementChild; if (li) li.append(el("br"), mdEl("span", l.trim())); continue; }
    const ind = m[1].replace(/\t/g, "    ").length, ordered = /\d/.test(m[2]);
    while (stack.length && ind < stack[stack.length - 1].ind) stack.pop();
    if (!stack.length || ind > stack[stack.length - 1].ind) {
      const list = el(ordered ? "ol" : "ul", ordered ? { start: String(parseInt(m[2], 10) || 1) } : {}), up = stack[stack.length - 1];
      (up ? up.list.lastElementChild || up.list : out).append(list);
      stack.push({ ind, list });
    }
    stack[stack.length - 1].list.append(mdEl("li", m[3]));
  }
  return out;
}
function md(text) {
  const out = document.createDocumentFragment(), L = String(text).split("\n");
  for (let i = 0; i < L.length;) {
    const l = L[i];
    let m;
    if (/^\s*```/.test(l)) { const buf = []; for (i++; i < L.length && !/^\s*```/.test(L[i]); i++) buf.push(L[i]); i++; out.append(el("pre", {}, el("code", {}, buf.join("\n")))); }
    else if (MD_ROW.test(l)) { const rows = []; for (; i < L.length && MD_ROW.test(L[i]); i++) rows.push(L[i]); out.append(mdTable(rows)); }
    else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { out.append(mdEl(`h${Math.min(6, m[1].length + 2)}`, m[2])); i++; }
    else if (MD_HR.test(l)) { out.append(el("hr")); i++; }
    else if (/^\s*>/.test(l)) { const buf = []; for (; i < L.length && /^\s*>/.test(L[i]); i++) buf.push(L[i].replace(/^\s*>\s?/, "")); out.append(el("blockquote", {}, md(buf.join("\n")))); }
    else if (MD_ITEM.test(l)) { const buf = []; for (; i < L.length && (MD_ITEM.test(L[i]) || /^\s{2,}\S/.test(L[i])); i++) buf.push(L[i]); out.append(mdList(buf)); }
    else if (!l.trim()) i++;
    else { const buf = [L[i++]]; while (i < L.length && L[i].trim() && !MD_BLOCK.test(L[i]) && !MD_HR.test(L[i])) buf.push(L[i++]); out.append(mdEl("p", buf.join("\n"))); }
  }
  return out;
}

// ---------- ② panel: 📂 Files, open / close / widen, width ----------
function setTab() {   // ② holds 📂 Files only: 📋 Tasks sits over the conversation in ① (案3, 2026-10-18)
  $("#app-files").hidden = false;
  filesStart();
}
const narrow = () => matchMedia("(max-width: 800px)").matches;
function setPane(p) {   // "open" | "closed" | "full" (full: ① stays at its narrowest, the panel's head stays)
  LS.aetherPane = p;
  $("#main").classList.toggle("closed", p === "closed");
  $("#main").classList.toggle("full", p === "full");
  document.body.classList.toggle("full", p === "full");
  $("#panel-btn").hidden = p !== "closed";
  const f = $("#panel-full"), on = p === "full";
  f.setAttribute("aria-pressed", String(on)); f.textContent = on ? "⤡" : "⤢";
  f.title = on ? "Back to the normal width (Esc)" : "Widen the panel"; f.setAttribute("aria-label", f.title);
}
function showLog() { if (narrow() && LS.aetherPane !== "closed") setPane("closed"); }   // on a phone the panel covers ①
function setPanelCw(w, save) {   // ① ≥ 360px, ② ≥ 320px; double-click resets to 1 : 1.4
  const m = $("#main");
  if (w === null) { m.classList.remove("cw"); m.style.removeProperty("--cw"); if (save) delete LS.aetherCw; return; }
  const cw = Math.round(Math.min(Math.max(w, 320), Math.max(320, m.getBoundingClientRect().width - 360)));
  m.style.setProperty("--cw", `${cw}px`); m.classList.add("cw");
  if (save) LS.aetherCw = String(cw);
}
function panelControls() {
  $("#panel-close").addEventListener("click", () => setPane("closed"));
  $("#panel-btn").addEventListener("click", () => setPane("open"));
  $("#panel-full").addEventListener("click", () => setPane($("#main").classList.contains("full") ? "open" : "full"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented && LS.aetherPane === "full") setPane("open"); });
  setPane(["closed", "full"].includes(LS.aetherPane) ? LS.aetherPane : "open");
  if (+LS.aetherCw) setPanelCw(+LS.aetherCw);
  const g = $("#p-resize"), dragging = () => document.body.classList.contains("resizing");
  g.addEventListener("pointerdown", (e) => { if (narrow() || e.button) return; e.preventDefault(); g.setPointerCapture(e.pointerId); document.body.classList.add("resizing"); });
  g.addEventListener("pointermove", (e) => { if (dragging()) setPanelCw($("#main").getBoundingClientRect().right - e.clientX); });
  const end = () => { if (!dragging()) return; document.body.classList.remove("resizing"); setPanelCw($("#panel").getBoundingClientRect().width, true); };
  for (const n of ["pointerup", "pointercancel", "lostpointercapture"]) g.addEventListener(n, end);
  g.addEventListener("dblclick", () => setPanelCw(null, true));
  g.addEventListener("keydown", (e) => { if (narrow() || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return; e.preventDefault(); setPanelCw($("#panel").getBoundingClientRect().width + (e.key === "ArrowLeft" ? 24 : -24), true); });
}

// ---------- 📋 Tasks: the queue, bundled by session · 🕘 Past (🧭 All is the icon left of ✕) ----------
// What runs and what waits, in the order it will run. A job is bundled by its task's session (the ref before "#"); a task without a ref
// is its own bundle (its conversation). Click a row: the conversation below shows that task. No buttons here (⏹ is on the job in ①)
// It also does what the breadcrumb over the messages did (2026-10-18 「メッセージのうえのパンクズと同じ役割をtasksで代用」): 🧭 All (the icon left of ✕) shows every task's
// messages, 🕘 Past lists the tasks with nothing running or waiting (newest first, bundled by session like the queue) so an ended session can be picked again
let HILITE = "";   // a task to mark (a quoted task was clicked)
const SFOLD = new Set(JSON.parse(LS.aetherSessFold || "[]"));   // folded bundles (🕘 Past itself is "past")
const PAST_STEP = 20;
let PASTN = PAST_STEP;   // how many ended tasks 🕘 Past shows (… more adds PAST_STEP)
const ago = (t) => { const v = Math.max(0, Date.now() / 1000 - t); return v < 60 ? "just now" : v < 3600 ? `${Math.floor(v / 60)}m ago` : v < 86400 ? `${Math.floor(v / 3600)}h ago` : `${Math.floor(v / 86400)}d ago`; };
const ENDWORD = { done: "✓ done", failed: "❌ failed", stopped: "⏹ stopped", "": "· no messages" };
const sessOf = (t) => (t.ref || "").split("#")[0].trim();   // ref "robosim-live/sessions/12#n7-3" → session "robosim-live/sessions/12"
const sessName = (k) => { const m = k.match(/^(?:(.*)\/)?sessions\/([^/]+)$/); return m ? `${m[1] ? `🧩 ${m[1].split("/").pop()} · ` : ""}#${m[2]}` : k; };
const clock = (x) => { const v = Math.max(0, Math.round(x)); return v < 60 ? `${v}s` : `${Math.floor(v / 60)}'${String(v % 60).padStart(2, "0")}s`; };   // 21s · 25'20s (2026-10-18 「[logo] · 25'20s」 ― the row keeps its room for the text)
const since = (t) => (t ? clock(Date.now() / 1000 - t) : "");
async function drawTasks() {
  const [q, all] = await Promise.all([api("api/queue"), api("api/tasks?all=1")]).catch(() => [null, null]);
  if (!q || !all) return;
  if (QDRAG) { QDRAG.stale = true; return; }   // a row is held: the list stays as it is until it is let go
  const run = q.filter((j) => j.state === "running").length, groups = new Map();   // first appearance = the order the queue reaches it
  for (const j of q) {
    const k = sessOf(j) ? `s:${sessOf(j)}` : `t:${j.task}`;
    if (!groups.has(k)) groups.set(k, { k, name: sessOf(j) ? sessName(sessOf(j)) : `💬 ${j.title || j.task}`, tip: sessOf(j) || "This task's conversation (no ref)", jobs: [] });
    groups.get(k).jobs.push(j);
  }
  $("#total").textContent = `${groups.size} session${groups.size === 1 ? "" : "s"} · ${q.length} task${q.length === 1 ? "" : "s"}`;   // read like 📂 Files' "6 folders · 12 files"
  const row = (j, shared, g) => { const mv = j.state === "queued" && g.jobs.filter((x) => x.state === "queued").length > 1; return el("div", { class: `qrow ${j.state}${mv ? " movable" : ""}${DEST && DEST.id === j.task ? " open" : ""}${HILITE === j.task ? " hit" : ""}`,
      "data-task": j.task, "data-title": j.title, "data-job": mv ? j.id : null, "data-sess": mv ? g.k : null, role: "button", tabindex: "0",
      title: fullText(j) + (mv ? "\n― drag up or down (Alt+↑/↓) to change the order it runs in this session" : "") },   // on hover: the whole instruction with what each @n quotes (2026-10-18 「タスクオンマウスで、「ここに、…@1📄 projects-v3/…」を表示」)
    // one line: ▶ text… [agent icon] · 21s … (2026-10-18 「▶ Tasksで完了したものは…{クロードロゴ} · 21s…」) ―― the state is a mark, its words are the tooltip
    el("span", { class: "qst", title: j.state === "running" ? "running" : `waiting #${j.pos} in this session`, "aria-label": j.state === "running" ? "running" : `waiting #${j.pos}` }, j.state === "running" ? el("span", { class: "spin", "aria-hidden": "true" }) : `⏳${j.pos}`),   // running is a spinner (2026-10-18 「▶ これは、スピナーにして」)
    el("span", { class: "qtx" }, shared && j.title && j.text && j.text !== j.title ? el("b", {}, `${short(j.title, 24)} · `) : null, ...withQuotes(j)),   // the task name only when it says more than the text
    el("span", { class: "qmeta" }, agentMark(j.agent), j.state === "running" ? el("span", { class: "qup", "data-started": String(j.started || "") }, ` · ${since(j.started)}`) : null),
    dots(j.id)); };
  const sess = (k, name, tip, n) => el("div", { class: `qsess${SFOLD.has(k) ? " shut" : ""}`, "data-sess": k, role: "button", tabindex: "0", title: `${name}\n${tip} ― click to fold or unfold` }, el("span", { class: "qsn" }, name), el("span", { class: "n" }, `· ${n}`));   // the name cut with … on one line, the count always shown
  $("#tall").setAttribute("aria-pressed", String(!DEST));   // 🧭 All is the icon left of ✕ (2026-10-18 「ALL の選択ボタンは、✕ の横にアイコンで出す」 ― was the first row of the list)
  const live = new Set(q.map((j) => j.task)), ended = all.filter((t) => !live.has(t.id)).map((t) => ({ ...t, last: t.last || t.ts })).sort((a, b) => b.last - a.last), shown = ended.slice(0, PASTN), past = new Map();   // last: a server started before it existed sends none
  for (const t of shown) {
    const k = sessOf(t) ? `s:${sessOf(t)}` : `t:${t.id}`;
    if (!past.has(k)) past.set(k, { k, name: sessOf(t) ? sessName(sessOf(t)) : "", tip: sessOf(t), tasks: [] });
    past.get(k).tasks.push(t);
  }
  const prow = (t, inner) => el("div", { class: `qrow ended${inner ? "" : " solo"}${DEST && DEST.id === t.id ? " open" : ""}${HILITE === t.id ? " hit" : ""}`, "data-task": t.id, "data-title": t.title, role: "button", tabindex: "0",
      title: `${t.title} ― click to open this task's conversation` },
    el("span", { class: "qst" }, ENDWORD[t.job] || t.job), el("span", { class: "qtx" }, t.title),
    el("span", { class: "qmeta", title: new Date(t.last * 1000).toLocaleString() }, t.agent ? [agentMark(t.agent), ` · ${ago(t.last)}`] : ago(t.last)), dots(""));
  const pastShut = SFOLD.has("past"), had = document.activeElement?.closest?.("#board .qrow"), hk = had && (had.dataset.job ? `[data-job="${CSS.escape(had.dataset.job)}"]` : `[data-task="${CSS.escape(had.dataset.task)}"]`);   // the focused row keeps the focus through the redraw (Alt+↑/↓ moves on from it)
  $("#board").replaceChildren(
    ...(q.length ? [...groups.values()].flatMap((g) => {
      const shared = g.k.startsWith("s:") && new Set(g.jobs.map((j) => j.task)).size > 1;
      return [sess(g.k, g.name, g.tip, g.jobs.length), ...(SFOLD.has(g.k) ? [] : g.jobs.map((j) => row(j, shared, g)))];
    }) : [el("p", { class: "fhint" }, "Nothing runs or waits. What you send queues here, bundled by session.")]),
    ...(ended.length ? [el("div", { class: `qsess past${pastShut ? " shut" : ""}`, "data-sess": "past", role: "button", tabindex: "0", title: "The tasks with nothing running or waiting, newest first ― click to fold or unfold" },
      "🕘 Past ", el("span", { class: "n" }, `· ${ended.length}`)),
      ...(pastShut ? [] : [...[...past.values()].flatMap((g) => g.tasks.length > 1 || g.name   // a session (ref) gets its heading; a task without one is its own row
        ? [sess(g.k, g.name, g.tip, g.tasks.length), ...(SFOLD.has(g.k) ? [] : g.tasks.map((t) => prow(t, true)))] : g.tasks.map((t) => prow(t, false))),
        ...(ended.length > PASTN ? [el("button", { type: "button", class: "qmore", "data-act": "more" }, `… ${Math.min(PAST_STEP, ended.length - PASTN)} more (of ${ended.length - PASTN})`)] : [])])] : []));
  if (hk) document.querySelector(`#board .qrow${hk}`)?.focus({ preventScroll: true });
  const m = $("#qmenu");   // an open … menu follows its row through the redraw (a running job redraws the list at every step)
  if (m && !m.hidden && m._btn && !m._btn.isConnected) {
    const nb = [...document.querySelectorAll("#board .qdots")].find((b) => b.closest(".qrow").dataset.task === m._row && (b.dataset.job || "") === (m._btn.dataset.job || ""));
    if (nb) { m._btn = nb; nb.setAttribute("aria-expanded", "true"); nb.closest(".qrow").classList.add("menu"); placeMenu(); } else closeRowMenu();
  }
}
function fullText(j) {   // the row's tooltip: the instruction in full, each @n followed by the whole name of what it quotes; quotes it does not name on their own lines
  const qs = new Map((j.quotes || []).filter((x) => x.n).map((x) => [x.n, x])), used = new Set();
  const body = String(j.full || j.text || j.title || "").replace(AT, (m, pre, n) => { const x = qs.get(+n); if (!x) return m; used.add(x.n); return `${pre}@${n}${x.label}`; });
  return [body, ...(j.quotes || []).filter((x) => !used.has(x.n)).map((x) => `${x.n ? `@${x.n}` : ""}${x.label}`)].join("\n");
}
function withQuotes(j) {   // the first line with each @n as the chip of what it quotes; quotes the line does not name follow it
  const qs = new Map((j.quotes || []).filter((x) => x.n).map((x) => [x.n, x])), body = j.text || j.title, out = [], used = new Set();
  const qchip = (x) => el("span", { class: "qq", title: x.label }, x.n ? el("b", {}, `@${x.n}`) : null, short(x.label, 28));
  let last = 0;
  for (const m of body.matchAll(AT)) {
    const x = qs.get(+m[2]); if (!x) continue;
    const at = m.index + m[1].length;
    out.push(body.slice(last, at), qchip(x)); used.add(x.n); last = at + 1 + m[2].length;
  }
  out.push(body.slice(last));
  return [...out, ...(j.quotes || []).filter((x) => !used.has(x.n)).map(qchip)];
}
// … at the end of a row: the menu of what its job can do (jobActs). One menu for the page, fixed to the viewport so the list's scroll cannot clip it
const dots = (jid) => el("button", { type: "button", class: "qdots", "data-act": "menu", "data-job": jid || null, title: "Quote, stop, edit…", "aria-label": "Actions", "aria-haspopup": "menu", "aria-expanded": "false" }, "…");
function closeRowMenu(back) {
  const m = $("#qmenu"); if (!m || m.hidden) return;
  m.hidden = true;
  const b = m._btn; if (b) { b.setAttribute("aria-expanded", "false"); b.closest(".qrow")?.classList.remove("menu"); if (back && b.isConnected) b.focus(); }
}
async function rowMenu(btn) {
  const m = $("#qmenu");
  if (!m.hidden && m._btn === btn) return closeRowMenu(true);
  closeRowMenu();
  const r = btn.closest(".qrow"), tid = r.dataset.task, jobs = (await api(`api/jobs?task=${encodeURIComponent(tid)}`)).jobs;
  const j = btn.dataset.job ? jobs.find((x) => x.id === btn.dataset.job) : jobs[jobs.length - 1];   // a past row: its last message
  const acts = j ? jobActs(j) : [{ how: "quote", icon: "📎", label: "Quote", tip: "Quote this task in ③", go: () => addQuotes([{ label: r.dataset.title || tid, text: "", task: tid }]) }];
  if (btn.dataset.job && (!j || ENDED.includes(j.state))) return drawTasks();   // it moved on meanwhile: the list is redrawn with its new state
  m.replaceChildren(...acts.map((a) => el("button", { type: "button", role: "menuitem", "data-how": a.how, title: a.tip, onclick: async (e) => {
    e.stopPropagation(); closeRowMenu();
    try { await a.go(); } catch (err) { alert(`❌ ${err.message}`); }
    drawTasks();
  } }, el("span", { class: "mi" }, a.icon), a.label)));
  m._btn = btn; m._row = tid; m.hidden = false; btn.setAttribute("aria-expanded", "true"); r.classList.add("menu");
  placeMenu(); m.querySelector("button").focus();
}
function placeMenu() {   // under the …, or above it near the bottom of the window
  const m = $("#qmenu"), b = m._btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(4, Math.min(b.right - w, innerWidth - w - 4))}px`;
  m.style.top = `${b.bottom + 4 + h > innerHeight - 4 ? Math.max(4, b.top - 4 - h) : b.bottom + 4}px`;
}
function tickQueue() { document.querySelectorAll("#board .qup[data-started]").forEach((e) => { if (+e.dataset.started) e.textContent = ` · ${since(+e.dataset.started)}`; }); }
// ① top: fold to one line, widen, or move the line between the tasks and the conversation (all remembered). A phone starts folded
// The heading row works like 📂 Files': ✕ folds and turns into ▾, which opens it again (no ⤢ here: 2026-10-18 "Tasksの⤢は、不要" ― the line below moves the height)
// (the 📋 Tasks title itself does not fold: 2026-10-18 "タスクの文字を押して開閉は、不要")
function foldTasks(on) {
  $("#tpane").classList.toggle("folded", on); LS.aetherTfold = on ? "1" : "0";
  const c = $("#tclose"); c.setAttribute("aria-expanded", String(!on)); c.textContent = on ? "▾" : "✕";
  c.title = on ? "Open the task list" : "Fold the task list to one line (▾ opens it again)"; c.setAttribute("aria-label", on ? "Open the task list" : "Fold the task list");
}
function setTh(px, save) {   // the height of the tasks (null: back to the default share)
  const L = $("#left");
  if (px === null) { L.style.removeProperty("--th"); if (save) delete LS.aetherTh; return; }
  const h = Math.round(Math.min(Math.max(px, 60), L.getBoundingClientRect().height - 120));
  L.style.setProperty("--th", `${h}px`); if (save) LS.aetherTh = String(h);
}
function splitControls() {
  foldTasks(LS.aetherTfold ? LS.aetherTfold === "1" : narrow());
  if (+LS.aetherTh) setTh(+LS.aetherTh);
  delete LS.aetherTfull;   // left by the ⤢ that was removed
  $("#tclose").addEventListener("click", () => foldTasks(!$("#tpane").classList.contains("folded")));
  $("#tall").addEventListener("click", () => { HILITE = ""; openView(null); showLog(); });   // 🧭 All (works while the list is folded too)
  const g = $("#lsplit"), on = () => document.body.classList.contains("tresizing");
  g.addEventListener("pointerdown", (e) => { if (e.button) return; e.preventDefault(); g.setPointerCapture(e.pointerId); document.body.classList.add("tresizing"); });
  g.addEventListener("pointermove", (e) => { if (on()) setTh(e.clientY - $("#left").getBoundingClientRect().top); });
  const end = () => { if (!on()) return; document.body.classList.remove("tresizing"); setTh($("#tpane").getBoundingClientRect().height, true); };
  for (const n of ["pointerup", "pointercancel", "lostpointercapture"]) g.addEventListener(n, end);
  g.addEventListener("dblclick", () => setTh(null, true));
  g.addEventListener("keydown", (e) => { if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return; e.preventDefault(); setTh($("#tpane").getBoundingClientRect().height + (e.key === "ArrowDown" ? 24 : -24), true); });
}
// Drag a waiting row up or down inside its session to change the order it runs in (2026-10-20 「Tasksのキューの順番をドラッグアンドドロップで入れ替えたい」).
// Only inside a session (other sessions run beside it anyway), and only where the session has two or more waiting. A mouse drags after 5px;
// a finger holds the row 0.35s first (a plain swipe scrolls the list). The list is not redrawn while a row is held (a running job redraws
// it at every step). Esc lets go without moving; Alt+↑/↓ on a focused row does the same from the keyboard
let QDRAG = null, QSWALLOW = false;   // QDRAG: {row, pid, y0, touch, on, timer, before, stale}; QSWALLOW: the click that follows a drop
const qpeers = (r) => [...document.querySelectorAll(`#board .qrow.movable[data-sess="${CSS.escape(r.dataset.sess)}"]`)];
async function moveQueued(row, before) {   // before: the job it goes in front of, null = last of its session. false: nothing to move
  const ids = qpeers(row).map((r) => r.dataset.job), me = row.dataset.job, now = ids.filter((x) => x !== me);
  now.splice(before ? now.indexOf(before) : now.length, 0, me);
  if (now.join() === ids.join()) return false;
  try { await api(`api/jobs/${me}/move`, { before }); }
  catch (err) { if (!/started|nothing was changed/.test(err.message)) alert(`❌ ${err.message}`); }   // it started meanwhile: the redraw shows where things are
  return true;
}
function queueDrag() {
  const pane = $("#tpane"), clear = () => document.querySelectorAll("#board .drop-before, #board .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  const begin = () => {
    const d = QDRAG; d.on = true; clearTimeout(d.timer); closeRowMenu();
    d.row.classList.add("dragging"); document.body.classList.add("qdragging");
    try { d.row.setPointerCapture(d.pid); } catch { /* the pointer is already up */ }
  };
  const aim = (y) => {   // the row the held one would go in front of (none: last), shown by a line
    const d = QDRAG, rows = qpeers(d.row), at = rows.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
    clear(); d.before = at ? at.dataset.job : null;
    (at || rows[rows.length - 1]).classList.add(at ? "drop-before" : "drop-after");
    const b = pane.getBoundingClientRect();
    if (y < b.top + 28) pane.scrollTop -= 10; else if (y > b.bottom - 28) pane.scrollTop += 10;   // near an edge the list scrolls
  };
  const end = async (drop) => {
    const d = QDRAG; if (!d) return;
    QDRAG = null; clearTimeout(d.timer);
    let moved = false;
    if (d.on) {
      d.row.classList.remove("dragging"); document.body.classList.remove("qdragging"); clear();
      QSWALLOW = true; setTimeout(() => { QSWALLOW = false; }, 50);
      if (drop) moved = await moveQueued(d.row, d.before);
    }
    if (moved || d.stale) drawTasks();
  };
  $("#board").addEventListener("pointerdown", (e) => {
    const r = e.target.closest(".qrow.movable");
    if (!r || e.button || e.target.closest("button") || QDRAG) return;
    QDRAG = { row: r, pid: e.pointerId, y0: e.clientY, touch: e.pointerType !== "mouse", on: false, before: null, stale: false };
    if (QDRAG.touch) QDRAG.timer = setTimeout(() => { if (QDRAG && !QDRAG.on) { begin(); aim(QDRAG.y0); navigator.vibrate?.(10); } }, 350);
  });
  document.addEventListener("pointermove", (e) => {
    const d = QDRAG; if (!d || e.pointerId !== d.pid) return;
    if (!d.on) {
      if (Math.abs(e.clientY - d.y0) < (d.touch ? 8 : 5)) return;
      if (d.touch) return end(false);   // moved before the hold: it was a swipe, the list scrolls
      begin();
    }
    e.preventDefault(); aim(e.clientY);
  });
  document.addEventListener("pointerup", (e) => { if (QDRAG && e.pointerId === QDRAG.pid) end(true); });
  for (const n of ["pointercancel", "lostpointercapture"]) document.addEventListener(n, (e) => { if (QDRAG && e.pointerId === QDRAG.pid) end(false); });
  $("#board").addEventListener("touchmove", (e) => { if (QDRAG && QDRAG.on) e.preventDefault(); }, { passive: false });   // held: the finger drags, the list does not scroll
  $("#board").addEventListener("contextmenu", (e) => { if (QDRAG) e.preventDefault(); });   // a long press would open the menu
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && QDRAG && QDRAG.on) { e.preventDefault(); end(false); } });
  $("#board").addEventListener("keydown", async (e) => {   // Alt+↑/↓: one place up or down
    const r = e.target.closest?.(".qrow.movable");
    if (!r || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault(); e.stopPropagation();
    const rows = qpeers(r), i = rows.indexOf(r), to = e.key === "ArrowUp" ? i - 1 : i + 2;
    if (to < 0 || i + 1 >= rows.length && e.key === "ArrowDown") return;
    if (await moveQueued(r, rows[to] ? rows[to].dataset.job : null)) {
      await drawTasks();
      document.querySelector(`#board .qrow[data-job="${CSS.escape(r.dataset.job)}"]`)?.focus();
    }
  });
}
function tasksEvents() {
  queueDrag();
  const go = async (e) => {
    if (QSWALLOW) return;   // the click a drop leaves behind
    const act = e.target.closest("button[data-act]");
    if (act && act.dataset.act === "more") { PASTN += PAST_STEP; return drawTasks(); }
    if (act) return rowMenu(act);   // …: the whole job is read first (the queue carries its first line only)
    const sh = e.target.closest(".qsess");
    if (sh) { const id = sh.dataset.sess; SFOLD.has(id) ? SFOLD.delete(id) : SFOLD.add(id); LS.aetherSessFold = JSON.stringify([...SFOLD]); return drawTasks(); }
    const r = e.target.closest(".qrow"); if (!r) return;
    HILITE = ""; openView({ id: r.dataset.task, title: r.dataset.title || r.dataset.task }); showLog();
  };
  $("#board").addEventListener("click", go);
  $("#board").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button")) { e.preventDefault(); go(e); } });
  const m = el("div", { id: "qmenu", class: "qmenu", role: "menu", hidden: "" });
  document.body.append(m);
  m.addEventListener("keydown", (e) => {
    const bs = [...m.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus(); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeRowMenu(true); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#qmenu, .qdots")) closeRowMenu(); });
  $("#board").addEventListener("scroll", () => closeRowMenu(), { passive: true });
  addEventListener("resize", () => closeRowMenu());
}

// ---------- 📂 Files: explorer (lazy), folder / file / app views ----------
const OPEN = new Set(JSON.parse(LS.aetherOpen || "[]")), KIDS = new Map();
let FOCUS = "", CUR = JSON.parse(LS.aetherCur || "null"), treeStale = false, FRAME = null;   // CUR: {kind: dir|file|app, path, app?}
const saveOpen = () => { LS.aetherOpen = JSON.stringify([...OPEN]); };
const EXT = { md: ["M↓", "#519aba"], txt: ["≡", "#8a93a6"], log: ["≡", "#8a93a6"], pdf: ["P", "#cc3e44"], pptx: ["P", "#e37933"], docx: ["W", "#3c78d8"], xlsx: ["X", "#5f9e3a"], csv: ["X", "#5f9e3a"],
  json: ["{}", "#b8a219"], yaml: ["⚙", "#a074c4"], yml: ["⚙", "#a074c4"], toml: ["⚙", "#a074c4"], py: ["py", "#3c78d8"], js: ["JS", "#b8a219"], ts: ["TS", "#3c78d8"], html: ["<>", "#e37933"],
  css: ["#", "#519aba"], sh: ["$", "#5f9e3a"], png: ["▣", "#a074c4"], jpg: ["▣", "#a074c4"], jpeg: ["▣", "#a074c4"], gif: ["▣", "#a074c4"], webp: ["▣", "#a074c4"], svg: ["▣", "#a074c4"] };
const extOf = (name) => (name.match(/\.([^./]+)$/) || ["", ""])[1].toLowerCase();
const icon = (name) => { const [t, c] = EXT[extOf(name)] || ["·", "#8a93a6"]; return el("span", { class: "ic", style: `color:${c}` }, t); };
const kb = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const parent = (p) => p.split("/").slice(0, -1).join("/");
const fileUrl = (p) => `files/${p.split("/").map(encodeURIComponent).join("/")}`;
async function kids(dir) {
  if (!KIDS.has(dir)) KIDS.set(dir, await api(`api/files?path=${encodeURIComponent(dir)}`));
  return KIDS.get(dir);
}
function drawTree() {
  const out = [];
  const walk = (dir, depth) => ((KIDS.get(dir) || {}).items || []).forEach((r) => {
    const open = r.dir && OPEN.has(r.path) && KIDS.has(r.path);
    out.push(el("div", { class: `frow${r.dir ? " dir" : ""}${CUR && r.path === CUR.path ? " sel" : ""}${r.path === FOCUS ? " focus" : ""}`, role: "treeitem", "data-path": r.path, title: r.path, "aria-expanded": r.dir ? String(open) : null },
      ...Array.from({ length: depth }, () => el("span", { class: "ig" })), el("span", { class: "tw" }), r.dir ? (r.app ? el("span", { class: "fapp" }, "🧩") : null) : icon(r.name), el("span", { class: "nm" }, r.name)));
    out[out.length - 1]._r = r;
    if (open) walk(r.path, depth + 1);
  });
  walk("", 0);
  $("#frows").replaceChildren(...(out.length ? out : [el("p", { class: "fhint" }, "Empty folder.")]));
}
const toFocus = () => document.querySelector("#frows .frow.focus")?.scrollIntoView({ block: "nearest" });
async function loadOpen(under) { await Promise.all([...OPEN].filter((d) => under == null || d.startsWith(`${under}/`)).map((d) => kids(d).catch(() => OPEN.delete(d)))); }
async function toggle(path, want = !OPEN.has(path)) {
  if (want) { try { await kids(path); OPEN.add(path); await loadOpen(path); } catch { OPEN.delete(path); } } else OPEN.delete(path);
  saveOpen(); drawTree();
}
async function reveal(path, openSelf = false) {   // open every folder above it and move to its row
  const parts = path ? path.split("/") : [];
  await kids("");
  for (let i = 1; i < parts.length + (openSelf ? 1 : 0); i++) { const d = parts.slice(0, i).join("/"); await kids(d); OPEN.add(d); }
  saveOpen(); FOCUS = path; drawTree(); toFocus();
}
async function refreshTree() { KIDS.clear(); await kids(""); await loadOpen(); saveOpen(); drawTree(); }
const view = (on) => $(".fx").classList.toggle("viewing", on);   // narrow panel: the tree or the preview
const fbtn = (text, go, attrs = {}) => el("button", { type: "button", onclick: go, ...attrs }, text);
function crumb(path) {   // workspace › a › b (click to open that folder in the tree)
  const parts = path ? path.split("/") : [], c = el("div", { class: "fcrumb" }, fbtn(INFO.workspace, () => { view(false); openDir(""); }));
  parts.forEach((p, i) => c.append(el("span", { class: "sep" }, "›"), i === parts.length - 1 ? el("b", {}, p) : fbtn(p, () => { view(false); const d = parts.slice(0, i + 1).join("/"); reveal(d, true); openDir(d); })));
  return c;
}
function bar(path, ...acts) { $("#fbar").replaceChildren(fbtn("← Explorer", () => { view(false); toFocus(); }, { class: "fback" }), crumb(path), el("div", { class: "facts" }, navBox(), ...acts, el("span", { class: "fext", role: "group", "aria-label": "Controls of the open page" }))); }
// The page's own controls (spec §3.1): text only, a few of them, and they die with the frame that sent them. The core's own (← → 📎 🔄) stay put
function extBar(items) {
  const box = $("#fbar .fext"); if (!box) return;
  const str = (v, n) => String(v ?? "").slice(0, n), fire = async (x, value = "", full = x.full) => {
    if (full && FRAME && !document.fullscreenElement) { try { await FRAME.requestFullscreen(); FULL = FRAME; FRAME.focus(); } catch { /* the page still hears the click */ } }
    post("bar", { id: x.id, value });
  };
  box.replaceChildren(...(Array.isArray(items) ? items : []).slice(0, 6).filter((x) => x && typeof x.id === "string").map((x) => {
    const opts = (Array.isArray(x.options) ? x.options : []).slice(0, 12).filter((o) => o && typeof o === "object")
      .map((o) => ({ head: o.head != null ? str(o.head, 24) : null, value: str(o.value, 60), label: str(o.label, 24), title: str(o.title, 200) || null, full: "full" in o ? !!o.full : !!x.full }));
    const label = str(x.label, 24), title = str(x.title, 200) || null, off = x.disabled ? "" : null;
    if (x.select) return el("label", { class: "fsel", title }, label ? el("span", { class: "lbl" }, label) : null,
      el("select", { "aria-label": label || x.id, disabled: off, onchange: (e) => fire(x, e.target.value, false) }, ...opts.filter((o) => o.head == null).map((o) => el("option", { value: o.value, title: o.title, selected: o.value === str(x.value, 60) ? "" : null }, o.label))));
    const main = fbtn(label || x.id, () => fire(x), { title, disabled: off, class: x.primary ? "primary" : null, "aria-label": title && !/\p{L}/u.test(label) ? title : null });   // an icon-only label (📎) is named by its title
    if (!opts.length) return main;
    const menu = el("div", { class: "fmenu", role: "menu", hidden: "" }, ...opts.map((o) => (o.head != null ? el("div", { class: "fmhead", role: "presentation" }, o.head)
      : fbtn([o.label, o.title ? el("small", {}, o.title) : null], () => { menu.hidden = true; fire(x, o.value, o.full); }, { role: "menuitem" }))));
    return el("span", { class: "fsplit" }, main, fbtn("▾", () => { const was = menu.hidden; document.querySelectorAll("#fbar .fmenu").forEach((m) => { m.hidden = true; }); menu.hidden = !was; },
      { class: "fmore", "aria-haspopup": "menu", "aria-label": `${label || x.id}: more`, disabled: off }), menu);
  }));
}
let FULL = null;   // the frame a "full" control put in full screen: tell it when it leaves (Esc)
document.addEventListener("fullscreenchange", () => { if (FULL && !document.fullscreenElement) { if (FULL === FRAME) post("fullscreen", { on: false }); FULL = null; } });
document.addEventListener("click", (e) => { if (!e.target.closest("#fbar .fsplit")) document.querySelectorAll("#fbar .fmenu").forEach((m) => { m.hidden = true; }); });
// Links inside a preview (page → core "file.open") keep a history: ← → in the bar. Anything else that opens a file or folder clears it
const NAV = { back: [], fwd: [], top: 0, going: false };
const here = () => CUR && { path: CUR.path, dir: CUR.kind === "dir", app: CUR.kind === "app" ? CUR.app : null, top: CUR.kind === "file" ? NAV.top : 0 };
function navBox() {
  const b = el("span", { class: "fnav", role: "group", "aria-label": "Link history", hidden: NAV.back.length || NAV.fwd.length ? null : "" },
    fbtn("←", () => navGo("back"), { class: "ficon", title: "Back", "aria-label": "Back", disabled: NAV.back.length ? null : "" }),
    fbtn("→", () => navGo("fwd"), { class: "ficon", title: "Forward", "aria-label": "Forward", disabled: NAV.fwd.length ? null : "" }));
  return b;
}
const navDraw = () => { const b = $("#fbar .fnav"); if (b) b.replaceWith(navBox()); };
async function navGo(dir) {
  const to = NAV[dir].pop(), from = here();
  if (!to) return;
  (dir === "back" ? NAV.fwd : NAV.back).push(from);
  if (CUR && CUR.kind === "file" && to.path === CUR.path && !to.dir) { NAV.top = to.top; post("scroll.to", { top: to.top }); return navDraw(); }   // a jump inside the same file
  NAV.going = true;
  try { await (to.app ? openApp(to.path, to.app) : to.dir ? openDir(to.path) : openFile(to.path, { top: to.top })); reveal(to.path).catch(() => {}); } finally { NAV.going = false; }
}
async function linkOpen(rel, hash) {   // page → core "file.open": a workspace path the page resolved. Folder or file, through the guarded API
  const from = here();
  if (CUR && CUR.kind === "file" && rel === CUR.path) { NAV.back.push(from); NAV.fwd = []; return navDraw(); }   // #anchor in the same file: the page scrolls itself
  const name = rel.split("/").pop(), d = await api(`api/files?path=${encodeURIComponent(parent(rel))}`), r = d.items.find((x) => x.name === name);
  if (!r) throw new Error("not found");
  NAV.going = true;
  try { await openRow(r); } finally { NAV.going = false; }
  NAV.back.push(from); NAV.fwd = []; navDraw(); reveal(rel, !!r.dir).catch(() => {});
}
function setCur(c) { if (!NAV.going) { NAV.back = []; NAV.fwd = []; } NAV.top = 0; CUR = c; LS.aetherCur = JSON.stringify(c); FOCUS = c.path; drawTree(); view(true); $(".fmain").classList.toggle("frame", c.kind !== "dir"); $(".fmain").scrollTop = 0; }
const quoteFolder = (path, app) => addQuotes([{ label: `${app ? "🧩" : "📁"} ${path}/`, text: "", path, rules: app && app.rules ? `${path}/${app.rules}` : "" }]);
const absPath = (path) => (path ? `${INFO.workspace_path}/${path}` : INFO.workspace_path);   // to paste into a terminal or another chat
const copyPath = (path, attrs = {}) => copyBtn(() => absPath(path), `Copy the path: ${absPath(path)}`, { class: "ficon", ...attrs });
async function openDir(path) {
  const d = await api(`api/files?path=${encodeURIComponent(path)}`);
  KIDS.set(path, d); FRAME = null; setCur({ kind: "dir", path });
  const nd = d.items.filter((r) => r.dir).length, nm = d.items.filter((r) => !r.dir && mediaOf(r.name)).length;
  const grid = nm > 0 && (LS.aetherGrid ? LS.aetherGrid === "1" : nm * 2 >= d.items.length - nd);   // the person's pick, else thumbnails when half the files or more are media
  bar(path, ...(d.app ? [fbtn(`▶ Open ${d.app.label}`, () => openApp(path, d.app))] : []),
    path ? fbtn("📎", () => quoteFolder(path, d.app), { class: "ficon", id: "fquotedir", title: `Quote this ${d.app ? "app" : "folder"} in ③`, "aria-label": `Quote this ${d.app ? "app" : "folder"} in ③` }) : null,
    copyPath(path, { id: "fcopypath" }),
    nm ? fbtn(grid ? "☰ List" : "▦ Thumbnails", () => { LS.aetherGrid = grid ? "0" : "1"; openDir(path); }, { id: "fgridbtn", title: grid ? "Show the files as a list" : "Show images and videos as thumbnails (remembered)" }) : null,
    el("span", { class: "fcount" }, `${nd} folders · ${d.items.length - nd} files`));
  const go = (r) => async () => { await openRow(r); reveal(r.path).catch(() => {}); };   // a folder opens its contents (an app folder: the app), a file its preview
  const lead = (r) => (r.dir ? el("span", { class: "fdi" }, r.app ? "🧩" : "📁") : icon(r.name));
  const row = (r) => el("li", {}, fbtn([lead(r), el("span", { class: "nm" }, r.name), el("span", { class: "fsz" }, r.dir ? "" : kb(r.size))], go(r)));
  if (!d.items.length) return $("#fbody").replaceChildren(el("p", { class: "fhint fempty" }, "Empty folder."));
  if (!grid) return $("#fbody").replaceChildren(el("ul", { class: "fdir" }, ...d.items.map(row)));
  const ul = el("ul", { class: "fgrid" }), more = el("p", { class: "fmore" });
  let shown = 0;
  const page = () => {
    ul.append(...d.items.slice(shown, shown + GRID_PAGE).map((r) => el("li", {}, fbtn([thumb(r) || el("span", { class: "fth" }, lead(r)), el("span", { class: "nm", title: r.name }, r.name), el("span", { class: "fsz" }, r.dir ? "" : kb(r.size))], go(r), { title: r.name }))));
    shown = Math.min(d.items.length, shown + GRID_PAGE);
    more.replaceChildren(...(shown < d.items.length ? [fbtn(`Show ${Math.min(GRID_PAGE, d.items.length - shown)} more (${shown} / ${d.items.length})`, page)] : []));
  };
  page();
  $("#fbody").replaceChildren(ul, more);
}
// ▦ Thumbnails: the shell is not sandboxed, so an image or a video loads straight from files/ (no thumbnails are made: the original is read).
// Images load lazily; a video gets its src only when it scrolls near, and shows its first frame (files/ has no Range: the whole file is read).
const MEDIA = { img: new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "apng"]), vid: new Set(["mp4", "m4v", "webm", "mov", "ogv"]) };
const mediaOf = (name) => { const x = extOf(name); return MEDIA.img.has(x) ? "img" : MEDIA.vid.has(x) ? "vid" : ""; };
const GRID_PAGE = 200;
const vidIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.src = e.target.dataset.src; vidIO.unobserve(e.target); } }), { rootMargin: "300px" });
function thumb(r) {
  const k = !r.dir && mediaOf(r.name), src = fileUrl(r.path);
  if (!k) return null;
  const fail = (e) => e.target.parentNode.replaceChildren(icon(r.name));
  if (k === "img") return el("span", { class: "fth" }, el("img", { src, alt: "", loading: "lazy", decoding: "async", draggable: "false", onerror: fail }));
  const v = el("video", { "data-src": `${src}#t=0.1`, muted: "", playsinline: "", preload: "metadata", disablepictureinpicture: "", onerror: fail,
    onmouseenter: (e) => { e.target.muted = true; e.target.play().catch(() => {}); }, onmouseleave: (e) => { e.target.pause(); e.target.currentTime = 0.1; } });   // hover plays it, silently
  vidIO.observe(v);
  return el("span", { class: "fth vid" }, v);
}
function snapFrame() {   // a page that fills its viewport (height: 100vh) in a frame of 713.5 px scrolls by half a pixel, on and off every frame
  const f = $("#fbody > iframe.fsite"), r = $("#fbody").getBoundingClientRect();   // (the scrollbar comes, the page shrinks, it goes ― robosim-live did): whole pixels only
  if (f && r.width) Object.assign(f.style, { flex: "none", width: `${Math.floor(r.width)}px`, height: `${Math.floor(r.height)}px` });
}
function frame(src, title, onload, ext = null) {   // ext: the preview extension (it may read its own folder)
  const f = el("iframe", { class: "fsite", src, sandbox: "allow-scripts allow-modals", allow: "fullscreen", title });
  f._ext = ext;
  f.addEventListener("load", () => { post("theme", { dark: false }); onload(); post("dest", { task: DEST }); });
  FRAME = f; $("#fbody").replaceChildren(f); snapFrame();
}
async function bytes(path) {   // a "binary": true preview gets the file as an ArrayBuffer (pptx, images…), read through the same guarded tree
  const r = await fetch(`files/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  if (+r.headers.get("Content-Length") > MAX_BINARY) throw new Error(`file is larger than ${MAX_BINARY / 1e6} MB`);
  return r.arrayBuffer();
}
const MAX_BINARY = 50e6;
const xstate = (id) => { try { return JSON.parse(LS[`aetherX.${id}`] || "null"); } catch { return null; } };
function previewOf(name) {   // several extensions may claim one file type: the person's pick (config open_with) wins, else the first found
  const ext = `.${extOf(name)}`, claims = (m) => INFO.previews.filter((x) => x.match.includes(m));
  const own = claims(ext), all = own.length ? own : claims("*");   // "*" only opens what no other preview takes
  return { ext, all, p: all.find((x) => x.id === (INFO.open_with || {})[ext]) || all[0] };
}
async function openFile(path, o = {}) {   // o.top: scroll position to restore (link history)
  const name = path.split("/").pop(), { ext, all, p } = previewOf(name);
  setCur({ kind: "file", path });
  const pick = all.length > 1 ? el("select", { class: "fwith", title: `Open ${ext} files with (remembered for every ${ext} file)`, "aria-label": `Open ${ext} with`,
    onchange: async (e) => { try { INFO.open_with = (await api("api/config", { open_with: { [ext]: e.target.value } })).open_with; } catch (err) { alert(err.message); } openFile(path); } },
  ...all.map((x) => el("option", { value: x.id, selected: x === p ? "" : null }, `${x.label} · ${x.id}`))) : null;
  bar(path, pick, fbtn("📎", () => addQuotes([{ label: `📄 ${path}`, text: "", path }]), { class: "ficon", title: "Quote this file in ③", "aria-label": "Quote this file in ③" }), copyPath(path),
    fbtn("🔄", () => openFile(path), { class: "ficon", title: "Reload" }));
  if (!p) { FRAME = null; return $("#fbody").replaceChildren(el("p", { class: "fhint fempty" }, `No preview extension for “${extOf(name) ? `.${extOf(name)}` : name}”. Quote it (📎) to hand it to the agent.`)); }
  frame(`x/${p.id}/${p.entry}`, name, async () => {
    try { post("open", { path, name, ...(o.top ? { top: o.top } : {}), state: xstate(p.id), ...(p.binary ? { data: await bytes(path) } : { text: (await api(`api/read?path=${encodeURIComponent(path)}`)).text }) }); }
    catch (err) { post("open", { path, name, error: err.message }); }
  }, p);
}
const openRow = (r) => (r.app ? Promise.resolve(openApp(r.path, r.app)) : r.dir ? openDir(r.path) : openFile(r.path));   // clicking a folder that is an app runs it
function openApp(path, app) {
  setCur({ kind: "app", path, app });
  bar(path, el("span", { class: "fhint" }, `🧩 ${app.label}`), fbtn("📁 Contents", () => openDir(path), { title: "Show the files of this folder" }),
    fbtn("📎", () => quoteFolder(path, app), { class: "ficon", title: "Quote this app in ③", "aria-label": "Quote this app in ③" }),
    app.url ? fbtn("🔄", () => openApp(path, app), { class: "ficon", title: "Reload", "aria-label": "Reload" }) : null);
  if (app.url) return openServed(app);
  frame(fileUrl(`${path}/${app.entry}`), app.label, () => post("open", { path, name: app.label, folder: true }));
}
function appUrl(u) {   // a server on this machine, as this page reaches it: through a relay (…/proxy/<port>/) the same relay's /proxy/<its port>/
  const x = new URL(u), relay = location.pathname.match(/^(.*\/proxy\/)\d+\//);
  return relay ? `${location.origin}${relay[1]}${x.port || (x.protocol === "https:" ? 443 : 80)}${x.pathname}${x.search}${x.hash}` : x.href;
}
async function openServed(app) {   // an app whose page a program on this machine serves (aether.json "url"): its own origin, so it runs as it would in a tab
  const src = appUrl(app.url), same = new URL(src).origin === location.origin, body = $("#fbody");
  FRAME = null; body.replaceChildren(el("p", { class: "fhint fempty" }, `Connecting to ${src} …`));
  const up = await fetch(src, { mode: "no-cors", cache: "no-store" }).then(() => true, () => false);
  if (CUR?.app !== app) return;   // another file was opened meanwhile
  if (!up) return body.replaceChildren(el("p", { class: "fhint fempty" }, `🔌 ${src} does not answer. Start the program that serves “${app.label}”, then press 🔄.`));
  const show = () => { const f = el("iframe", { class: "fsite", src, title: app.label, allow: "fullscreen", sandbox: "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads" }); FRAME = f; body.replaceChildren(f); snapFrame(); };
  if (!same) return show();   // another origin than the shell: it cannot reach the shell's page or API
  body.replaceChildren(el("div", { class: "fhint fempty fwarn" },   // through a relay both sit on one origin: the page could call the shell's API, so the person decides each time
    el("p", {}, `⚠ Through this relay, “${app.label}” runs on the same origin as AetherRSI: its page could use AetherRSI's API (send messages, change the workspace).`),
    el("p", {}, fbtn("▶ Open it", show, { class: "primary" }), " ", el("a", { href: src, target: "_blank", rel: "noopener" }, "↗ or open it in its own tab"))));
}
function post(type, data = {}) { if (FRAME && FRAME.contentWindow) FRAME.contentWindow.postMessage({ aether: INFO && INFO.protocol, type, ...data }, "*"); }
let filesUp = false;
async function filesStart() {   // first time the tab opens: the tree, then what was open before
  if (filesUp) { if (treeStale) { treeStale = false; refreshTree().catch(() => {}); } return; }
  filesUp = true;
  $("#froot").textContent = INFO.workspace; $("#froot").title = INFO.workspace_path;
  await kids("").catch(() => {}); await loadOpen(); drawTree();
  const c = CUR;
  if (c) (c.kind === "dir" ? openDir(c.path) : c.kind === "app" ? Promise.resolve(openApp(c.path, c.app)) : openFile(c.path)).then(() => view(false)).catch(empty);
  else empty();
}
function empty() { $("#fbar").replaceChildren(); $(".fmain").classList.remove("frame"); $("#fbody").replaceChildren(el("p", { class: "fhint fempty" }, "Pick a file in the explorer on the left to see it here.")); }
function filesEvents() {
  $("#frows").addEventListener("click", (e) => {
    const r = e.target.closest(".frow"); if (!r) return;
    FOCUS = r.dataset.path;
    if (!r.classList.contains("dir")) return openFile(FOCUS);
    if (e.target.closest(".tw")) toggle(FOCUS); else openRow(r._r);   // the chevron opens and closes; the name shows the folder (an app folder runs the app)
  });
  $("#ftree").addEventListener("keydown", (e) => {
    const rows = [...document.querySelectorAll("#frows .frow")], i = rows.findIndex((r) => r.dataset.path === FOCUS), cur = rows[i];
    const go = (j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { FOCUS = r.dataset.path; drawTree(); toFocus(); } };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if (!cur) return;
    else if (e.key === "ArrowRight") { if (cur.classList.contains("dir")) (cur.getAttribute("aria-expanded") === "true" ? go(i + 1) : toggle(FOCUS, true)); }
    else if (e.key === "ArrowLeft") { if (cur.getAttribute("aria-expanded") === "true") toggle(FOCUS, false); else if (FOCUS.includes("/")) { FOCUS = parent(FOCUS); drawTree(); toFocus(); } }
    else if (e.key === " ") (cur.classList.contains("dir") ? toggle(FOCUS) : openFile(FOCUS));
    else if (e.key === "Enter") openRow(cur._r);
    else return;
    e.preventDefault();
  });
  $("#fcollapse").addEventListener("click", () => { OPEN.clear(); saveOpen(); drawTree(); });
  $("#frefresh").addEventListener("click", () => refreshTree());
  $(".fsash").addEventListener("pointerdown", (e) => {   // drag to resize the tree
    e.preventDefault();
    const fx = $(".fx"), w0 = $("#ftree").getBoundingClientRect().width;
    const move = (ev) => fx.style.setProperty("--fw", `${Math.round(Math.max(140, Math.min(w0 + ev.clientX - e.clientX, fx.clientWidth * 0.6)))}px`);
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); LS.aetherTreeW = fx.style.getPropertyValue("--fw"); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  });
  if (LS.aetherTreeW) $(".fx").style.setProperty("--fw", LS.aetherTreeW);
  new ResizeObserver(() => { const w = $("#app-files").clientWidth; if (w) $("#fbar").classList.toggle("narrow", w <= 560); }).observe($("#app-files"));
  new ResizeObserver(snapFrame).observe($("#fbody"));
}
window.addEventListener("message", async (e) => {   // only from the frame we opened
  if (!FRAME || e.source !== FRAME.contentWindow || !e.data || typeof e.data.type !== "string") return;
  const d = e.data, o = CUR;
  if (d.type === "quote.add") addQuotes([{ label: `${o.kind === "app" ? "🧩" : "📄"} ${o.path}${d.label ? ` · ${String(d.label).slice(0, 60)}` : ""}`, text: String(d.text || "").slice(0, 20000), path: o.path,
    rules: o.kind === "app" && o.app.rules ? `${o.path}/${o.app.rules}` : "" }]);
  else if (d.type === "send") { const ta = $("#say"); ta.value = LS.aetherDraft = (ta.value ? `${ta.value}\n` : "") + String(d.text || ""); growSay(); ta.focus(); }
  else if (d.type === "task.open") { const t = (await api("api/tasks?all=1")).find((x) => x.id === d.id); if (t) openView(t); }
  else if (d.type === "read") {   // an app reads files of its own folder; a preview reads files of its extension folder
    const rel = String(d.path || ""), reply = (x) => post("reply", { id: d.id, ...x }), ext = FRAME._ext;
    if ((o.kind !== "app" && !ext) || !rel || rel.startsWith("/") || rel.split("/").includes("..")) return reply({ ok: false, error: "pages may read only inside their own folder" });
    try {
      if (o.kind === "app") return reply({ ok: true, text: (await api(`api/read?path=${encodeURIComponent(`${o.path}/${rel}`)}`)).text });
      const r = await fetch(`x/${encodeURIComponent(ext.id)}/${rel.split("/").map(encodeURIComponent).join("/")}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      reply({ ok: true, text: await r.text() });
    } catch (err) { reply({ ok: false, error: err.message }); }
  }
  else if (d.type === "fetch") {   // an app asks the shell to fetch from a server of its own (manifest "ports"): through a cookie-authenticated relay the sandboxed page's own requests carry no cookie
    const fail = (error) => post("reply", { id: d.id, ok: false, error });
    let u; try { u = new URL(String(d.url || "")); } catch { return fail("not a URL"); }
    const port = +u.port, mine = +(location.pathname.match(/\/proxy\/(\d+)\//)?.[1] || location.port);
    if (o.kind !== "app" || !LOOPBACK.test(u.href) || port === mine) return fail("apps may fetch only from the ports their aether.json names");
    const f = FRAME, ports = await (f._ports ||= api(`api/files?path=${encodeURIComponent(o.path)}`).then((x) => x.app?.ports || [], () => []));   // the manifest as it is now, once per frame: CUR comes back from localStorage as it was saved
    if (!ports.includes(port)) return fail("apps may fetch only from the ports their aether.json names");
    const method = d.method === "POST" ? "POST" : "GET", type = d.contentType ? { "Content-Type": String(d.contentType) } : {};
    try {
      const r = await fetch(appUrl(u.href), { method, headers: type, body: method === "POST" ? d.body : undefined, cache: "no-store", credentials: "include" });
      const data = await r.arrayBuffer();
      if (FRAME && CUR === o) FRAME.contentWindow.postMessage({ aether: INFO && INFO.protocol, type: "reply", id: d.id, ok: true, status: r.status, statusText: r.statusText, contentType: r.headers.get("Content-Type") || "", data }, "*", [data]);
    } catch (err) { fail(err.message); }
  }
  else if (d.type === "url.open") { const u = String(d.url || ""); if (/^(https?|mailto):/i.test(u)) window.open(u, "_blank", "noopener"); }   // an outside link in a preview (the frame has no allow-popups)
  else if (d.type === "file.open") {   // a link in a preview: open that workspace file or folder here (the page resolved the path)
    const rel = String(d.path || "").replace(/^\/+|\/+$/g, ""), reply = (x) => post("reply", { id: d.id, ...x });
    if (rel.split("/").includes("..")) return reply({ ok: false, error: "outside the workspace" });
    try { await linkOpen(rel, d.hash); reply({ ok: true, text: "" }); } catch (err) { reply({ ok: false, error: err.message }); }
  }
  else if (d.type === "state" && FRAME._ext) { const v = JSON.stringify(d.value ?? null); if (v.length <= 4096) LS[`aetherX.${FRAME._ext.id}`] = v; }   // a preview's own small memory (unit picks…), kept in this browser
  else if (d.type === "scroll") NAV.top = Math.max(0, +d.top || 0);   // where the page is (for ← →)
  else if (d.type === "bar") extBar(d.items);
  else if (d.type === "fullscreen" && !d.on && FULL === FRAME && document.fullscreenElement) document.exitFullscreen().catch(() => {});   // the page ends its show (the frame cannot: the full-screen element is in this document)
  else if (d.type === "download" && d.data instanceof ArrayBuffer) {   // bytes the page made (an MP4 it encoded…): the frame cannot download them itself
    const u = URL.createObjectURL(new Blob([d.data], { type: String(d.mime || "application/octet-stream") }));
    el("a", { href: u, download: String(d.name || "download").split(/[\\/]/).pop() || "download" }).click(); setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  else if (d.type === "download" && o.kind === "file") el("a", { href: fileUrl(o.path), download: o.path.split("/").pop() }).click();
});

// ---------- start ----------
function composerEvents() {
  const ta = $("#say");
  ta.value = LS.aetherDraft || "";
  ta.addEventListener("input", (e) => { LS.aetherDraft = ta.value; growSay(); if (!e.isComposing) { atSel = 0; drawAt(); } });
  ta.addEventListener("compositionend", () => setTimeout(drawAt));
  ta.addEventListener("click", () => { if (!$("#atmenu").hidden) drawAt(); });
  ta.addEventListener("blur", () => closeAt());
  ta.addEventListener("keydown", (e) => {
    if (!$("#atmenu").hidden && !e.isComposing) {
      const os = $("#atmenu").querySelectorAll("button");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); atSel = (atSel + (e.key === "ArrowDown" ? 1 : -1) + os.length) % os.length; return drawAt(); }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") { e.preventDefault(); return insertAt(+os[atSel].dataset.n, 1); }
      if (e.key === "Escape") { e.preventDefault(); return closeAt(); }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("#send-more").addEventListener("click", (e) => { e.stopPropagation(); sendMenu($("#send-menu").hidden); });
  $("#send-menu").addEventListener("click", (e) => {
    const a = e.target.closest("button[data-agent]");
    if (a) { setAgent(a.dataset.agent, true); sendMenu(false); return ta.focus(); }   // picking an agent does not send
    const b = e.target.closest("button[data-mode]"); if (b) { sendMenu(false); send(b.dataset.mode); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#sendbox")) sendMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#send-menu").hidden) { sendMenu(false); $("#send-more").focus(); } });
  $("#agents").replaceChildren(...INFO.agents.map((a) => el("button", { type: "button", role: "menuitemradio", "data-agent": a.id, "aria-checked": "false", disabled: a.disabled ? "" : null, title: a.disabled || null },
    a.label, a.disabled ? el("small", {}, a.disabled) : a.spare ? el("small", {}, "Spare copy from the core (this workspace has no extensions/ with it)") : null)));
  setAgent(INFO.agent);
  window.addEventListener("focus", pullAgent);
  growSay(); new ResizeObserver(() => growSay()).observe($("#composer"));
  QUOTES = numbered(QUOTES); drawDest();
}
let busy = false;
async function poll() {
  tick();
  if (busy || document.hidden) return;
  busy = true;
  try {
    const { rev, reloading } = await api("api/poll");
    if (rev !== REV) {
      REV = rev; RELOADING = !!reloading;
      await sync();
      drawTasks();
      if (treeStale && filesUp) { treeStale = false; refreshTree().catch(() => {}); }
      post("rev", { rev });
    }
  } catch (err) { console.error(err); } finally { busy = false; }
}
function wsDialog(required) {   // the workspace folder: asked on a fresh install (no cancel), changeable later unless --workspace fixed it
  const d = $("#wsdlg"), err = $("#wserr"), note = $("#wsnote"), inp = $("#wspath"), ok = $("#wsok");
  inp.value = INFO.workspace_path || ""; err.hidden = true;
  note.hidden = !(required || INFO.workspace_error);
  note.textContent = INFO.workspace_error ? `⚠ ${INFO.workspace_error}` : "No workspace is set yet. Enter the folder to work in; it is saved for the next start.";
  $("#wscancel").hidden = required;
  d.oncancel = (e) => { if (required) e.preventDefault(); };   // Esc cannot skip the first setup
  $("#wscancel").onclick = () => d.close();
  const use = async (path) => {
    ok.disabled = true; err.hidden = true;
    try { await api("api/config", { workspace: path }); location.reload(); }   // everything (tree, extensions, open files) belongs to the old folder
    catch (x) { err.textContent = `❌ ${x.message}`; err.hidden = false; ok.disabled = false; inp.focus(); }
  };
  $("#wsform").onsubmit = (e) => { e.preventDefault(); use(inp.value); };
  const recent = INFO.recent || [];   // the folders used last (the core keeps them): one click switches
  $("#wsrecent").hidden = !recent.length;
  $("#wslist").replaceChildren(...recent.map((p) => {
    const at = p.lastIndexOf("/"), cur = p === INFO.workspace_path;
    return el("button", { type: "button", title: p, disabled: cur ? "" : null, onclick: () => use(p) },
      el("b", {}, p.slice(at + 1)), el("small", {}, el("bdi", {}, p.slice(0, at) || "/")), cur ? el("em", {}, "current") : null);
  }));
  d.showModal(); inp.focus(); inp.select();
}
async function start() {
  INFO = await api("api/info");
  $("#ver").textContent = `v${INFO.version}`;
  $("#ver").title = `AetherRSI ${INFO.version} · protocol ${INFO.protocol} · ${INFO.locked ? "🔒 core locked" : "🔓 core unlocked"} (${INFO.lock_reason})`;   // the lock is one hover away
  $("#fws").title = INFO.workspace_fixed ? `${INFO.workspace_path} (given at start with --workspace)` : `Change the workspace folder (now ${INFO.workspace_path || "not set"})`;
  $("#fws").disabled = INFO.workspace_fixed;
  $("#fws").onclick = () => wsDialog(false);
  if (!INFO.workspace) return wsDialog(true);   // nothing else works without a folder (the API answers 409)
  if (INFO.errors.length) { $("#warn").hidden = false; $("#warn").textContent = `⚠ ${INFO.errors.length} extension(s) skipped`; $("#warn").title = INFO.errors.join("\n"); }
  $("#phead").insertBefore($("#fbar"), $("#panel-full"));
  panelControls(); splitControls(); composerEvents(); tasksEvents(); filesEvents();
  window.addEventListener("hashchange", () => { const id = decodeURIComponent((location.hash.match(/task=([^&]+)/) || [])[1] || ""); if (id !== ((DEST && DEST.id) || "")) linked(id); });
  setTab(); drawTasks();
  await linked(decodeURIComponent((location.hash.match(/task=([^&]+)/) || [])[1] || ""));
  setInterval(poll, POLL);
}
async function linked(id) {   // DeepLink: #task=<id>
  const t = id ? (await api("api/tasks?all=1")).find((x) => x.id === id) : null;
  setDest(t); await sync(true, true);
  if (id && !t) bubble("bot", "⚠️ The linked task was not found (deleted, or a wrong id). Showing 🧭 All.");
}
start().catch((e) => bubble("bot", `❌ Could not load: ${e.message}`));
