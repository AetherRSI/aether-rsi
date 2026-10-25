// AetherRSI shell: ① 📋 Tasks (🧭 All · 🔄 In progress bundled by session · 👀 To review · ✅ Done) over the conversation of one task (or 🧭 All) · ② the panel (📂 Files) · ③ the composer.
// Survives a reload: the open task is the URL's #task=<id>, the draft, quotes, the line between tasks and conversation, panel width and open folders live in localStorage.
// Previews and apps run in sandboxed iframes and talk to this page only through postMessage (spec/v0.1.md §3).
const $ = (s) => document.querySelector(s);
// Icons are one-colour Material icons (icons.js, 2026-10-24 "use these icons everywhere, each a simple single colour"):
// a string that starts with a known emoji ("📎 Quote", "❌ " + error) draws that emoji as the icon, and tooltips drop it. The data keeps its emoji
// (quote labels "📄 a.md", agent steps "📜 …" are words the agent reads too) ―― only the drawing changes. Arrows are typography inside a sentence:
// they become an icon only when they stand alone (a ← button)
const lead = (k) => {
  if (typeof k !== "string" || (/^[←→↑↓]/.test(k) && !/^[←→↑↓]$/.test(k.trim()))) return [k];
  const [s, w] = muiLead(k);
  if (!s) return [k];
  if (w) s.classList.add("lead");
  return w ? [s, w] : [s];
};
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) k.startsWith("on") ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, k === "title" || k === "aria-label" ? muiPlain(v) : v);
  e.append(...kids.flat(Infinity).filter((k) => k != null && k !== false).flatMap(lead));   // any depth: [icon, words] may sit inside a list of kids
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
// "when a message would change a task another task is editing, ask the person first"). Approved → the same request again with confirm: true.
// A new message can instead wait in that task's queue (2026-10-24 "can there be a button to put it in the editing task's queue?"): its session
// runs one job at a time, so it starts after the edit, in the same conversation ―― no confirm needed for that one.
function approve(hits, what, queue) {   // → "ok" · "q<i>" (wait in hits[i]'s queue) · anything else: no
  const d = $("#okdlg");
  $("#okwhat").textContent = what;
  $("#oklist").replaceChildren(...hits.map((h, i) => el("li", {}, el("b", {}, `▶ ${h.title || h.task}`), " is editing ", ...h.paths.map((x, k) => [k ? ", " : "", el("code", {}, x)]),
    queue && el("button", { value: `q${i}`, class: "okq", title: `Wait in this task's queue: it runs after the job editing it now, in the same conversation`, "aria-label": `Queue after ${h.title || h.task}` },
      mui("PlaylistAdd"), "Queue after it"))));
  return new Promise((done) => {
    d.onclose = () => done(d.returnValue);
    d.returnValue = ""; d.showModal(); $("#okno").focus();   // the safe choice has the focus
  });
}
async function approved(path, body, what) {   // api() with the approval step in between
  try { return await api(path, body); }
  catch (e) {
    if (!(e.body && e.body.conflict)) throw e;
    const hits = e.body.conflict, plain = path === "api/send" && "agent" in body;   // a message of its own (not ↪ / ➕ / ✎): it may join the editing task
    const how = await approve(hits, what, plain), h = plain && /^q\d+$/.test(how) && hits[+how.slice(1)];
    if (h) return approved(path, { ...body, task: h.task, parallel: false }, what);   // another session that edits it too still asks
    if (how !== "ok") return null;   // null: the person said no ―― nothing was sent
    return api(path, { ...body, confirm: true });
  }
}
const agentOf = (id) => INFO.agents.find((a) => a.id === id) || { id, label: id || "agent" };
const agentMark = (id) => {   // the manifest's icon where room is short, else the label. One colour: the logo's shape filled with the text colour (a mask)
  const a = agentOf(id);
  return a.icon ? el("span", { class: "amark", role: "img", "aria-label": a.label, title: a.label, style: `--mask:url("${encodeURI(a.icon)}")` }) : a.label;
};   // the manifest's icon where room is short, else the label
const agentBadge = (id) => { const a = agentOf(id); return a.icon ? [agentMark(id), ` ${a.label.replace(/^\P{L}+/u, "")}`] : [a.label]; };   // icon + name, the label's emoji dropped (2026-10-22 "💎 Gemini Argon is working ― use the Gemini or Claude icon here too")
async function copyText(text, btn) {   // the copy icon → a check (or a cross) for a moment
  let ok = true;
  try { await navigator.clipboard.writeText(text); }
  catch {   // no clipboard API (an http origin that is not localhost): the old way
    const t = el("textarea", { readonly: "", style: "position:fixed;opacity:0" }); t.value = text; document.body.append(t); t.select();
    ok = document.execCommand("copy"); t.remove();
  }
  btn._kids ||= [...btn.childNodes]; btn.replaceChildren(mui(ok ? "Check" : "Close"));
  clearTimeout(btn._t); btn._t = setTimeout(() => { btn.replaceChildren(...btn._kids); }, 1500);
}
const copyBtn = (get, tip, attrs = {}) => el("button", { type: "button", class: "copy", title: tip, "aria-label": tip, ...attrs,
  onclick: (e) => { e.stopPropagation(); copyText(get(), e.currentTarget); } }, mui("ContentCopy"));

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
  QUOTES = qs; LS.aetherQuotes = JSON.stringify(qs); drawDest(); drawMic();
}
function addQuotes(qs) {   // the same thing is quoted once (and keeps its number)
  const same = (q, x) => (q.task || x.task ? q.task === x.task : q.text === x.text && q.label === x.label);
  setQuotes([...QUOTES.filter((q) => !qs.some((x) => same(q, x))), ...qs.map((x) => { const o = QUOTES.find((q) => same(q, x)); return o && o.n ? { ...x, n: o.n } : x; })]);
  mention(qs.map((x) => QUOTES.find((q) => same(q, x))));
  $("#say").focus();
}
// Every quote taken puts its @n where the cursor of ③ is, again if it was quoted before (2026-10-24 "after a clip, always insert the @ where the cursor of the message box is").
// The textarea keeps its caret while another pane has the focus, so a 📎 pressed in the explorer or a preview lands where the person left off
function mention(qs) { qs.filter((q) => q && q.n).forEach((q) => insertAt(q.n)); }
function clearQuotes() {   // the ✕ of every chip at once (the 📨 To: stays): each @n in the text becomes its name, a pasted image's file goes
  const was = QUOTES;
  setQuotes([]);
  was.filter((q) => q.paste).forEach((q) => api(`api/paste/${q.paste}/drop`, {}).catch(() => {}));
  $("#say").focus();
}
function chip(text, tip, off, cls, n, img) {   // img: a thumbnail before the text (a pasted image). text: a string, or parts each drawn with its own head icon
  const x = el("button", { type: "button", "aria-label": tip, onclick: off }, "✕"), pic = img ? el("img", { class: "qimg", src: img, alt: "" }) : null;
  const all = [text].flat().join("");
  if (!n) return el("span", { class: cls, title: all }, pic, el("span", {}, text), x);
  const at = el("b", { class: "at", role: "button", tabindex: "0", "aria-label": `Insert @${n}`, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertAt(n); } } }, `@${n}`);
  return el("span", { class: `${cls} mention`, title: `${all}\nClick to insert @${n} at the cursor`, onclick: (e) => { if (!e.target.closest("button")) insertAt(n); } }, at, pic, el("span", {}, text), x);
}
function drawDest() {
  const d = $("#dest");
  d.hidden = !DEST && !QUOTES.length;
  d.replaceChildren(...(DEST ? [chip(["📨 To: ", DEST.title], "Remove the destination (back to 🧭 All)", () => openView(null), "chip")] : []),
    ...QUOTES.map((q, i) => chip(quoteName(q), q.edit ? "Stop editing (the queued message stays as it was)" : q.paste ? "Remove the image (its file goes too)" : "Remove the quote",
      () => { setQuotes(QUOTES.filter((_, k) => k !== i)); if (q.paste) api(`api/paste/${q.paste}/drop`, {}).catch(() => {}); },   // a message that still quotes it keeps it (the server checks)
      q.inject ? "chip quote inject" : q.append || q.edit ? "chip quote queued" : "chip quote", q.n || 0, q.paste ? `api/paste/${q.paste}` : null)),
    ...(QUOTES.length > 1 ? [el("button", { type: "button", id: "qclear", title: `Remove all ${QUOTES.length} quotes`, onclick: clearQuotes }, mui("ClearAll"), el("span", {}, "Clear all"))] : []));   // replaceChildren draws a null as the text "null"
}
// A pasted image (Cmd+V in ③) becomes a quote "🖼 Pasted image n" holding its file's absolute path, and @n goes where the cursor is.
// The file is kept outside the workspace and swept by the server (paste.py), so nothing piles up. Shrunk first to 1568 px on its long
// side, what the model would do anyway, so a Retina screenshot stays far below the 5 MB an image may weigh.
const PASTED = /[0-9a-f]{16}\.(?:png|jpg|gif|webp)$/;
async function shrink(blob, side = 1568, cap = 3_700_000) {
  const bm = await createImageBitmap(blob), k = Math.min(1, side / Math.max(bm.width, bm.height));
  if (k === 1 && blob.size <= cap && /^image\/(png|jpeg|gif|webp)$/.test(blob.type)) return blob;
  const c = el("canvas", { width: Math.round(bm.width * k), height: Math.round(bm.height * k) });
  c.getContext("2d").drawImage(bm, 0, 0, c.width, c.height);
  const as = (type, q) => new Promise((done) => c.toBlob(done, type, q));
  const png = await as("image/png");
  return png.size <= cap ? png : as("image/jpeg", 0.9);   // a photo: JPEG
}
async function pasteImages(e) {
  const imgs = [...(e.clipboardData?.items || [])].filter((x) => x.kind === "file" && x.type.startsWith("image/")).map((x) => x.getAsFile());
  if (!imgs.length || e.clipboardData.types.includes("text/plain")) return;   // text with a picture of itself (cells, slides): the text
  e.preventDefault();
  for (const f of imgs) {
    try {
      const b = await shrink(f), r = await fetch("api/paste", { method: "POST", headers: { "Content-Type": b.type, "X-Aether": "1" }, body: b });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      addQuotes([{ label: `🖼 Pasted image ${QUOTES.filter((q) => q.paste).length + 1}`, text: j.path, paste: j.name }]);   // @n goes in with it
    } catch (err) { alert(`The image could not be pasted: ${err.message}`); }
  }
}
function growSay(max = 6) {   // grow with the text; past `max` lines it scrolls inside
  const ta = $("#say"); if (!ta.offsetParent) return;
  const cs = getComputedStyle(ta), bd = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const lim = parseFloat(cs.lineHeight) * max + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + bd, st = ta.scrollTop;
  ta.style.height = "auto"; const h = ta.scrollHeight + bd;
  ta.style.height = `${Math.min(h, lim)}px`; ta.style.overflowY = h > lim + 1 ? "auto" : "hidden";
  ta.scrollTop = document.activeElement === ta && ta.selectionEnd === ta.value.length ? ta.scrollHeight : st;
}
let CARET = null;   // [start, end] of ③ when it lost the focus; null: never placed (an @ goes at the end)
function insertAt(n, drop = 0) {   // "@n " at the cursor (drop: the @ typed to open the menu)
  const ta = $("#say"), v = ta.value;
  let [a, b] = document.activeElement === ta || drop ? [Math.max(0, ta.selectionStart - drop), ta.selectionEnd] : CARET ? CARET.map((x) => Math.min(x, v.length)) : [v.length, v.length];
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
  showLog(); mention([QUOTES.find((q) => q.job === j.id)]); $("#say").focus();
}
function addInject(j) {   // ↪ Quote on a running job: what you send next goes into that conversation
  if ((j.task || "") !== ((DEST && DEST.id) || "")) openView({ id: j.task, title: j.title || j.task });
  setQuotes([...QUOTES.filter((q) => !target(q)), { label: short(j.title || j.text), text: "", inject: j.id, tid: j.task, ...(agentOf(j.agent).audio ? { audio: true } : {}) }]);
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
// get the same one (2026-10-22 "it says Gemini but Claude Code ran" ―― it lived in localStorage and the core still said claude-code)
async function setAgent(id, save = false) {
  const ok = INFO.agents.filter((a) => !a.disabled);
  AGENT = ok.some((a) => a.id === id) ? id : INFO.agent;
  $("#agents").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.agent === AGENT)));
  $("#send .agent").replaceChildren(agentMark(AGENT));   // arrow_upward + the agent's logo (2026-10-22 "make Send an ↑ and the agent's logo", "use the Material icon arrow_upward")
  $("#send").title = muiPlain(`Send to ${agentOf(AGENT).label} (▾ to switch)`);
  $("#send").setAttribute("aria-label", $("#send").title);
  drawMic();
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
    // ↪ an inject carries its quotes in the text (compose): a pasted image is not left behind
    const r = await approved("api/send", inj ? { text: compose(said, qs), inject: inj.inject } : onto ? { text: said, quotes: qs, ...(onto.edit ? { edit: onto.edit } : { append: onto.append }) }
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

// ---------- 🎙 voice (spec/v0.1.md §4.2) ----------
// An agent whose manifest says audio: true hears the person while it runs (2026-10-24 "change the core so the agents that support it
// take live voice input"). 🎙 sends ③ as a new message with voice: true (or, with ↪ on a running job of such an agent, opens the
// mic into it); the core hands a WebSocket ticket, the mic streams PCM16 16 kHz up, the agent's voice (24 kHz) is played as it comes. What was said
// is kept as the job's steps (🎙 / 🔊), so the conversation above shows it. A dropped socket (a --reload swap) opens again by itself.
const MIC = { job: null, state: "", ws: null, ctx: null, out: null, src: null, node: null, stream: null, next: 0, playing: [], tries: 0 };
const MIC_WORKLET = `class P extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Int16Array(1600); this.n = 0; }
  process(i) { const c = i[0] && i[0][0]; if (!c) return true;
    for (let k = 0; k < c.length; k++) { const s = Math.max(-1, Math.min(1, c[k])); this.b[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.b.length) { this.port.postMessage(this.b.buffer, [this.b.buffer]); this.b = new Int16Array(1600); this.n = 0; } }
    return true; } }
registerProcessor("aether-mic", P);`;   // 1,600 samples = 100 ms at 16 kHz
const micInto = () => QUOTES.find((q) => q.inject && q.audio);   // ↪ on a running job of an agent that hears
function drawMic() {
  const b = $("#mic");
  if (!b || !INFO) return;
  const on = !!MIC.job, into = micInto(), can = on || !!into || (!QUOTES.some(target) && !!agentOf(AGENT).audio);
  b.hidden = !can;
  b.setAttribute("aria-pressed", String(on));
  b.classList.toggle("live", on && MIC.state === "live");
  b.classList.toggle("busy", on && MIC.state !== "live");
  b.replaceChildren(mui(on ? "MicOff" : "Mic"));
  b.title = on ? ({ live: "Listening ― press to close the mic (the agent finishes the conversation)", wait: "Waiting for the agent to start (press to cancel)" }[MIC.state] || "Opening the mic…")
    : into ? `Talk into the running conversation: ${into.label}` : `Talk to ${agentOf(AGENT).label} (what is in ③ goes with it)`;
  b.setAttribute("aria-label", b.title);
}
async function micToggle() {
  if (MIC.job) return micClose();
  try {   // made inside the click, so the browser lets them sound and listen
    MIC.out ||= new AudioContext({ sampleRate: 24000 }); MIC.out.resume();
    MIC.ctx = new AudioContext({ sampleRate: 16000 }); MIC.ctx.resume();
  } catch (e) { return bubble("bot", `❌ This browser cannot play or record sound here: ${e.message}`); }
  const into = micInto();
  MIC.job = into ? into.inject : "pending"; MIC.state = ""; drawMic();
  try { MIC.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { micReset(); return bubble("bot", `❌ No microphone: ${e.message}`); }
  if (into) return micConnect();
  const ta = $("#say"), said = ta.value.trim() || "🎙 Voice", qs = QUOTES.filter(mentionable);
  let r;
  try { r = await approved("api/send", { text: said, task: DEST ? DEST.id : "", agent: AGENT, quotes: qs, voice: true }, "This message quotes it too: two agents may change the same files."); }
  catch (e) { micReset(); return bubble("bot", `❌ ${e.message}`); }
  if (!r) return micReset();   // not approved: ③ stays as it is
  ta.value = ""; growSay(); delete LS.aetherDraft; closeAt(); setQuotes([]);
  MIC.job = r.job; micConnect();
  if (r.task && r.task.id !== (DEST && DEST.id)) openView(r.task); else sync(true);
}
async function micConnect() {
  const jid = MIC.job;
  let t;
  try { t = (await api(`api/jobs/${jid}/audio`, {})).ticket; }
  catch (e) {
    if (MIC.job !== jid) return;
    if (!e.body && MIC.tries++ < 5) return setTimeout(micConnect, 1000 * MIC.tries);   // the core is swapping in new code: try again
    micReset(); return e.body ? sync() : bubble("bot", `❌ The mic could not open: ${e.message}`);
  }
  if (MIC.job !== jid) return;
  const u = new URL(`api/jobs/${jid}/audio?ticket=${encodeURIComponent(t)}`, location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  const ws = MIC.ws = new WebSocket(u);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return micPlay(e.data);
    const m = JSON.parse(e.data);
    if (m.interrupted) return micHush();
    if (m.ui) return uiAnswer(ws, m.ui);
    if (MIC.ws !== ws || MIC.job !== jid) return;
    if (m.type === "wait" && MIC.state !== "wait") { MIC.state = "wait"; drawMic(); }
    else if (m.type === "ready") { MIC.state = "live"; MIC.tries = 0; drawMic(); micCapture(); }
    else if (m.type === "end") { MIC.ws = null; micReset(); sync(); }
  };
  ws.onclose = () => {
    if (MIC.ws !== ws || MIC.job !== jid) return;   // closed on purpose, or the job ended
    MIC.ws = null;
    if (MIC.tries++ < 5) return setTimeout(micConnect, 1000 * MIC.tries);
    micReset();   // said, not silent: the agent goes on talking to nobody, and the person took it for a talk that does not answer (2026-10-25)
    bubble("bot", "❌ The mic lost its connection to the core (tried 5 times): the agent no longer hears you. Press 🎙 again, or ⏹ Stop that job");
  };
}
async function micCapture() {
  if (MIC.node) return;   // opened again after a drop: it records already
  try {
    await MIC.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([MIC_WORKLET], { type: "text/javascript" })));
    if (!MIC.stream) return;
    MIC.src = MIC.ctx.createMediaStreamSource(MIC.stream);
    MIC.node = new AudioWorkletNode(MIC.ctx, "aether-mic");
    MIC.node.port.onmessage = (e) => { if (MIC.ws && MIC.ws.readyState === 1 && MIC.state === "live") MIC.ws.send(e.data); };
    MIC.src.connect(MIC.node); MIC.node.connect(MIC.ctx.destination);   // pulled by the output (it writes silence)
  } catch (e) { bubble("bot", `❌ Could not record: ${e.message}`); micClose(); }
}
function micPlay(buf) {
  const ctx = MIC.out, i16 = new Int16Array(buf);
  if (!ctx || !i16.length) return;
  const ab = ctx.createBuffer(1, i16.length, 24000), f = ab.getChannelData(0);
  for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 32768;
  const src = ctx.createBufferSource(), at = Math.max(ctx.currentTime + 0.03, MIC.next);
  src.buffer = ab; src.connect(ctx.destination); src.start(at); MIC.next = at + ab.duration;
  MIC.playing.push(src); src.onended = () => { MIC.playing = MIC.playing.filter((x) => x !== src); };
}
function micHush() { for (const s of MIC.playing) { try { s.stop(); } catch { /* ended */ } } MIC.playing = []; MIC.next = 0; }   // the person cut in
function micClose() {   // the person closed the mic: the agent finishes; its last words still play (the socket stays until the end)
  const ws = MIC.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "end" }));
    ws.onclose = null; MIC.ws = null;
    ws.onmessage = ((on) => (e) => { if (typeof e.data !== "string") return on(e); const m = JSON.parse(e.data); if (m.interrupted) micHush(); if (m.type === "end") { ws.close(); sync(); } })(ws.onmessage);
  }
  micReset(ws && ws.readyState === 1 ? ws : null);
}
function micReset(keep = null) {
  if (MIC.ws && MIC.ws !== keep) { const w = MIC.ws; MIC.ws = null; w.onclose = null; try { w.close(); } catch { /* gone */ } }
  if (MIC.stream) MIC.stream.getTracks().forEach((t) => t.stop());
  try { if (MIC.src) MIC.src.disconnect(); if (MIC.node) MIC.node.disconnect(); } catch { /* gone */ }
  if (MIC.ctx) MIC.ctx.close().catch(() => {});
  Object.assign(MIC, { job: null, state: "", stream: null, src: null, node: null, ctx: null, tries: 0 });
  drawMic();
}

// 🖱 The screen for an agent that hears (spec §4.4, 2026-10-24 "know every control on the browser screen the mouse and keyboard can reach,
// and operate it by voice"): it asks over the mic's socket, aetherUI (aether-sdk.js) lists and drives this page; the page open in the panel answers for itself
// when it loads the SDK (its items are "f1", "f2"…). The mic button is never listed: the agent must not close its own ear.
const UIQ = new Map();
let uiSeq = 0;
function uiFrame(q, wait = 1500) {   // → the framed page's answer (null: no frame, or it has no SDK)
  const f = FRAME;
  if (!f || !f.contentWindow || !f.isConnected || !f.getBoundingClientRect().width) return Promise.resolve(null);
  const id = ++uiSeq;
  return new Promise((ok, ng) => {
    UIQ.set(id, { ok, ng });
    f.contentWindow.postMessage({ aether: INFO && INFO.protocol, type: "ui", id, ...q }, "*");
    setTimeout(() => { if (UIQ.delete(id)) q.op === "snapshot" ? ok(null) : ng(new Error("the page in the panel does not answer (it does not load aether-sdk.js)")); }, wait);
  });
}
async function uiDo(q) {
  if (/^f\d+$/.test(String(q.n ?? ""))) return uiFrame({ ...q, n: +String(q.n).slice(1) }, 5000);
  if (q.op !== "snapshot") return aetherUI.act(q);
  const me = aetherUI.snapshot("#mic"), fr = $("dialog[open]") ? null : await uiFrame({ op: "snapshot" });
  const where = CUR && $("#panel") && !$("#panel").hidden ? `${CUR.kind === "app" ? "🧩" : CUR.kind === "dir" ? "📁" : "📄"} ${CUR.path}` : "";
  return { ...me, task: DEST ? DEST.title || DEST.id : "🧭 All", panel: where,
    items: [...me.items, ...(fr ? fr.items.map((x) => ({ ...x, n: `f${x.n}`, area: `Panel › ${x.area || where}` })) : [])],
    ...(fr ? { panel_title: fr.title } : {}) };
}
async function uiAnswer(ws, q) {
  let a;
  try { a = { type: "ui", id: q.id, result: await uiDo(q) }; } catch (e) { a = { type: "ui", id: q.id, error: e.message }; }
  if (ws.readyState === 1) ws.send(JSON.stringify(a));
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
  const mk = (q, inline) => {
    const pic = q.label.startsWith("🖼 ") && (q.text.match(PASTED) || [])[0];   // a pasted image: its thumbnail while the server keeps it
    return src([q.at && !inline ? `@${q.at} ` : null, pic && !inline ? el("img", { class: "qimg", src: `api/paste/${pic}`, alt: "", onerror: (e) => e.target.remove() }) : null, short(q.label, 40)],
      `Click to show it on the right and quote it again: ${q.label}`, () => {
        const s = srcOf(q); if (s) show(s);
        addQuotes([{ label: q.label, text: q.text, ...(s ? { path: s.path } : {}), ...(pic ? { paste: pic } : {}) }]);
      });
  };
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
// What one job can do, in one order for both places (2026-10-18 "put … at the end of a task with a menu behind it … the same inside the message (icons only)"):
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
// a step the agent cut short ends with …: click it for the whole text, again to close (2026-10-18 "the agent log in Tasks is cut short: end it with … and show it all on click")
// as SoloGen v3 shows it: the … follows the text on the same line and the whole line is the switch (2026-10-18 "show the agent log in the message view with … the way SoloGen v3 does")
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
  else if (j.state === "done") kids.push(fileLinks(el("div", { class: "md" }, md(j.reply || "(no reply)"))), j.cost != null ? el("div", { class: "step" }, `$${j.cost.toFixed(3)}`) : null);
  else if (j.state === "stopped") kids.push(el("div", { class: "step" }, "⏹ Stopped"));
  else kids.push(el("div", { class: "err" }, `❌ ${j.error || "Failed"}`));
  if (j.state !== "done" && j.error && j.state !== "failed") kids.push(el("div", { class: "err" }, j.error));
  kids.push(haltBar(j));
  b.replaceChildren(...kids.filter(Boolean));
}
const HELLO = "AetherRSI. Write what you want done and send it (⌘Enter). Each message becomes a task and its conversation opens here; click a row in {Assignment} Tasks above to continue a task ({Visibility} To review has the ones that ended, {CheckCircle} Done the ones you marked done). Each session runs one task at a time; different sessions run side by side.";
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
  if (DEST && !r.task) { bubble("bot", muiText("{Warning} That task is gone (or the link is wrong). Showing {Explore} All.")); return openView(null); }
  if (DEST && r.task.title !== DEST.title) { DEST.title = r.task.title; drawDest(); }
  // decided once, before anything moves: just sent (a pending pair) or at the bottom → it ends at the bottom. A redraw from scratch (the last 40
  // slide by one at every send in a long task) went through the unstuck meBubble insert and left the view at the top (2026-10-24 "after sending the view scrolls up")
  const follow = fresh || !!log.querySelector(".pending") || atEnd(), top = log.scrollTop;
  log.querySelectorAll(".pending").forEach((x) => x.remove());
  const shown = [...log.querySelectorAll(".msg.bot[data-jid]")].map((x) => x.dataset.jid), ids = r.jobs.map((j) => j.id);
  const redraw = fresh || shown.some((id, i) => ids[i] !== id);
  if (redraw) {   // another view, or the order changed (priority send, the window of 40 moved): draw from scratch
    log.replaceChildren();   // which view this is: the open row in 📋 Tasks (🧭 All or the task) and 📨 To: over ③ (2026-10-18: no breadcrumb over the messages)
    if (!DEST) bubble("bot hello", muiText(HELLO));
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
  if (JUMP) { toJob(JUMP) || toEnd(); JUMP = ""; }   // a message picked in a listed thread: shown once its view is drawn
  else if (follow) toEnd();
  else if (redraw) log.scrollTop = top;   // reading further up: a redraw does not throw the view to the top
}
function tick() {   // the seconds move without redrawing (a redraw under the pointer would swallow the ⏹ click)
  tickQueue();
  document.querySelectorAll("#log .msg.bot[data-jid]").forEach((b) => { const up = b.querySelector(".up"); if (up && b._job) up.textContent = upTime(b._job); });
}

// Markdown for replies: headings, lists (nested by indent), tables, code, quotes, rules, **bold**, `code`, links. Text is escaped first
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function mdInline(s) {
  const keep = [], put = (h) => `\u0000${keep.push(h) - 1}\u0000`, out = (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => out(keep[i]));
  const h = esc(s).replace(/`([^`]+)`/g, (_, c) => put(fileA(c, `<code>${c}</code>`, true)))
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => put(`<a href="${u}" target="_blank" rel="noopener">${t}</a>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, p) => { const a = fileA(p, t); return a === t ? m : put(a); })
    .replace(/(^|[\s（(])(https?:\/\/[^\s<）)]+)/g, (_, b, u) => b + put(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`))
    .replace(MD_PATH, (m, b, p) => { const a = fileA(p, p); return a === p ? m : b + put(a); });
  return out(h);
}
// A file or folder the reply names ―― `a/b.py`, [name](a/b.py), /…/workspace/a/b.py:12, or a/b.py in the text ―― opens in 📂 Files.
// It is drawn as a link only once the workspace is found to have it (fileLinks): a path outside the workspace, or one that is not there, stays text
// (2026-10-24 "when the message view mentions a file, can it link to it in Files?")
const MD_SEG = "[^\\s/<>\"'`|()（）「」『』【】、。，,:：;；*\\u0000]+";
const MD_PATH = new RegExp(`(^|[\\s（(「『【>])((?:\\.?/)?(?:${MD_SEG}/)+(?:${MD_SEG}?\\.[A-Za-z0-9]{1,8}(?!\\w|\\.\\w)|[\\w.\\-]+/?)?(?::\\d+)*)`, "gu");
const unesc = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, c) => ({ amp: "&", lt: "<", gt: ">", quot: '"' }[c]));
function wsRel(p) {   // a path as the reply wrote it → relative to the workspace, or "" (outside it, or not a path)
  p = p.replace(/(?::\d+)+$|#.*$/, "");
  try { p = decodeURIComponent(p); } catch {}
  const ws = INFO && INFO.workspace_path;
  if (p.startsWith("/")) { if (!ws || !p.startsWith(`${ws}/`)) return ""; p = p.slice(ws.length); }
  p = p.replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
  return p.split("/").some((x) => x === ".." || x === ".") ? "" : p;
}
function fileA(p, inner, code = false) {   // p and inner are escaped already; inner comes back as it was when p is not a path
  const raw = unesc(p);
  if (code && (/[\s()<>{}[\]'"|*,;]/.test(raw) || !/\/|\.[A-Za-z0-9]{1,8}(:\d+)*$/.test(raw))) return inner;   // `git diff`, `f(x)`: code, not a path
  if (/^[a-z][\w+.-]*:/i.test(raw) && !/^[^:]+(:\d+)+$/.test(raw)) return inner;   // mailto:, file:… (but a/b.py:12 is a path)
  const rel = wsRel(raw);
  return rel ? `<a class="flink" href="#" data-path="${esc(rel)}">${inner}</a>` : inner;
}
const FL_SEEN = new Map();   // folder → its listing, for half a minute (every reply in a long log asks at once when it opens)
function flList(dir) {
  const hit = FL_SEEN.get(dir);
  if (hit && Date.now() - hit.at < 30000) return hit.items;
  const items = api(`api/files?path=${encodeURIComponent(dir)}`).then((x) => x.items || [], () => []);
  FL_SEEN.set(dir, { at: Date.now(), items });
  return items;
}
async function flFind(rel) {   // down from the workspace one folder at a time: only folders that are there are asked for (no 404 per word that looked like a path)
  let dir = "", r = null;
  for (const name of rel.split("/")) {
    if (r && !r.dir) return null;
    r = (await flList(dir)).find((x) => x.name === name);
    if (!r) return null;
    dir = dir ? `${dir}/${name}` : name;
  }
  return r;
}
function fileLinks(root) {   // keep the file links the workspace has; the others go back to text
  for (const a of root.querySelectorAll("a.flink:not(.ok)")) {
    const rel = a.dataset.path;
    flFind(rel).then((r) => {
      if (!r) return a.replaceWith(...a.childNodes);
      a.classList.add("ok"); a.title = `Open in Files: ${rel}${r.dir ? "/" : ""}`;
    });
  }
  return root;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.flink");
  if (!a) return;
  e.preventDefault();
  if (!a.classList.contains("ok")) return;
  if ($("#main").classList.contains("closed")) setPane("open");
  setTab("files");
  linkOpen(a.dataset.path).catch((err) => alert(`${a.dataset.path}: ${err.message}`));
});
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
function setTab() {   // ② holds 📂 Files only: 📋 Tasks sits over the conversation in ① (option 3, 2026-10-18)
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
  f.setAttribute("aria-pressed", String(on)); f.replaceChildren(mui(on ? "CloseFullscreen" : "OpenInFull"));
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

// ---------- 📋 Tasks: 🔄 In progress · 👀 To review · ✅ Done (🧭 All is the icon left of ✕) ----------
// 2026-10-24 "can Tasks be split into running, your turn and done? A session with no queue is one line":
// 🔄 In progress: what runs and what waits, in the order it will run, bundled by its task's session (the ref before "#"; a task without a ref
//   is its own bundle). A session with a queue gets a heading over its rows; one with nothing waiting is one row, its name before the text.
// 👀 To review: the tasks whose jobs all ended but nobody marked done yet (its mark says how the last one ended: ✓ done · ❌ failed · ⏹ stopped).
//   One whose last reply asks you something (the core's asks) comes first: its spinner turns, then halts at the top, again and again, beside
//   Your turn ―― alive, but held until you answer (2026-10-24 "one waiting for the person's answer keeps its spinner and shows it is held for a reply…").
// ✅ Done: the tasks marked done (… › ✓ Mark done; sending to one again brings it back to 🔄). In both, a session is one row (its newest task);
//   its count ▸ n unfolds the rest. Newest first, 20 rows at a time. Click a row: the conversation below shows that task.
//   A task whose thread holds 2 or more messages gets ▸ at its left: it lists them under the row (each instruction, how it ended, when);
//   click one to see it in the conversation (2026-10-24 "a done one with two or more exchanges opens and closes to show them")
// It also does what the breadcrumb over the messages did (2026-10-18): 🧭 All (the icon left of ✕) shows every task's messages
let HILITE = "";   // a task to mark (a quoted task was clicked)
const SFOLD = new Set(JSON.parse(LS.aetherSessFold || "[]"));   // folded bundles of 🔄 and folded sections ("live" · "check" · "done")
const SOPEN = new Set(JSON.parse(LS.aetherSessOpen || "[]"));
const TOPEN = new Set(JSON.parse(LS.aetherThreadOpen || "[]"));   // tasks of 👀 / ✅ whose thread is listed under their row
const THREADS = new Map();   // task id → {last, jobs}: a listed thread, read again when the task moves   // sessions of 👀 / ✅ unfolded by ▸ n ("check:s:…" · "done:s:…")
const PAST_STEP = 20;
const MORE = { check: PAST_STEP, done: PAST_STEP };   // how many session rows 👀 / ✅ show (… more adds PAST_STEP)
const ago = (t) => { const v = Math.max(0, Date.now() / 1000 - t); return v < 60 ? "just now" : v < 3600 ? `${Math.floor(v / 60)}m ago` : v < 86400 ? `${Math.floor(v / 3600)}h ago` : `${Math.floor(v / 86400)}d ago`; };
const ENDWORD = { done: "done", failed: "failed", stopped: "stopped", "": "no messages" };
// how a task or a job ended, as a Material icon (its word is the tooltip: 2026-10-24 "can the done status be shown as an icon?")
const ENDICON = { done: "CheckCircle", failed: "Error", stopped: "StopCircle", "": "RadioButtonUnchecked" };
const endMark = (state, cls = "qst") => el("span", { class: `${cls} st-${state || "none"}`, title: ENDWORD[state] ?? state }, ENDICON[state] !== undefined || state === "" ? mui(ENDICON[state], { title: ENDWORD[state] ?? state }) : state);
const sessOf = (t) => (t.ref || "").split("#")[0].trim();   // ref "robosim-live/sessions/12#n7-3" → session "robosim-live/sessions/12"
const sessName = (k) => { const m = k.match(/^(?:(.*)\/)?sessions\/([^/]+)$/); return m ? `${m[1] ? `🧩 ${m[1].split("/").pop()} · ` : ""}#${m[2]}` : k; };
const clock = (x) => { const v = Math.max(0, Math.round(x)); return v < 60 ? `${v}s` : `${Math.floor(v / 60)}'${String(v % 60).padStart(2, "0")}s`; };   // 21s · 25'20s (2026-10-18 「[logo] · 25'20s」 ― the row keeps its room for the text)
const since = (t) => (t ? clock(Date.now() / 1000 - t) : "");
const SECICON = { live: "Autorenew", check: "RateReview", done: "TaskAlt" };
const SECTION = { live: ["In progress", "What runs and what waits, bundled by session"], check: ["To review", "Ended, not marked done yet ― … › ✓ Mark done when you have looked"], done: ["Done", "Marked done ― sending to one again brings it back to 🔄"] };
async function drawTasks() {
  const [q, all] = await Promise.all([api("api/queue"), api("api/tasks?all=1")]).catch(() => [null, null]);
  if (!q || !all) return;
  if (QDRAG) { QDRAG.stale = true; return; }   // a row is held: the list stays as it is until it is let go
  const groups = new Map();   // first appearance = the order the queue reaches it
  for (const j of q) {
    const k = sessOf(j) ? `s:${sessOf(j)}` : `t:${j.task}`;
    if (!groups.has(k)) groups.set(k, { k, name: sessOf(j) ? sessName(sessOf(j)) : `💬 ${j.title || j.task}`, tip: sessOf(j) || "This task's conversation (no ref)", jobs: [] });
    groups.get(k).jobs.push(j);
  }
  const live = new Set(q.map((j) => j.task)), ended = all.filter((t) => !live.has(t.id)).map((t) => ({ ...t, last: t.last || t.ts })).sort((a, b) => b.last - a.last);   // last: a server started before it existed sends none
  const bundles = (sec) => {   // 👀 / ✅: one bundle per session (a task without a ref is its own), newest first
    const m = new Map();
    for (const t of ended.filter((x) => (x.status === "done") === (sec === "done"))) {
      const k = sessOf(t) ? `s:${sessOf(t)}` : `t:${t.id}`;
      if (!m.has(k)) m.set(k, { k, name: sessOf(t) ? sessName(sessOf(t)) : "", tip: sessOf(t), tasks: [] });
      m.get(k).tasks.push(t);
    }
    const bs = [...m.values()];
    return sec === "check" ? [...bs.filter((g) => g.tasks[0].asks), ...bs.filter((g) => !g.tasks[0].asks)] : bs;   // waiting for your answer first, each half newest first
  };
  const listed = ended.filter((t) => TOPEN.has(t.id) && t.turns > 1);   // the threads to list: read the ones not read since they last moved
  await Promise.all(listed.filter((t) => THREADS.get(t.id)?.last !== t.last).map((t) => api(`api/jobs?task=${encodeURIComponent(t.id)}`).then((r) => THREADS.set(t.id, { last: t.last, jobs: r.jobs })).catch(() => {})));
  if (QDRAG) { QDRAG.stale = true; return; }
  const check = bundles("check"), done = bundles("done"), nCheck = check.reduce((s, g) => s + g.tasks.length, 0), nDone = done.reduce((s, g) => s + g.tasks.length, 0), nAsk = check.filter((g) => g.tasks[0].asks).length;
  $("#total").textContent = `${q.length} in progress${nAsk ? ` · ${nAsk} waiting for you` : ""} · ${nCheck} to review`;   // read like 📂 Files' "6 folders · 12 files"
  const lead = (name) => (name ? el("b", {}, `${short(name, 24)} · `) : null);   // a session that is one row: its name before the text
  const row = (j, g, one) => { const mv = j.state === "queued" && g.jobs.filter((x) => x.state === "queued").length > 1, shared = !one && g.k.startsWith("s:") && new Set(g.jobs.map((x) => x.task)).size > 1;
    return el("div", { class: `qrow ${j.state}${one ? " solo" : ""}${mv ? " movable" : ""}${DEST && DEST.id === j.task ? " open" : ""}${HILITE === j.task ? " hit" : ""}`,
      "data-task": j.task, "data-title": j.title, "data-job": mv ? j.id : null, "data-sess": mv ? g.k : null, role: "button", tabindex: "0",
      title: (one && g.k.startsWith("s:") ? `${g.tip}\n` : "") + fullText(j) + (mv ? "\n― drag up or down (Alt+↑/↓) to change the order it runs in this session" : "") },   // on hover: the whole instruction with what each @n quotes (2026-10-18 "on hover over a task, show 'here, …@1📄 projects-v3/…'")
    // one line: ▶ text… [agent icon] · 21s … (2026-10-18 "▶ a done one in Tasks … {Claude logo} · 21s…") ―― the state is a mark, its words are the tooltip
    el("span", { class: "qst", title: j.state === "running" ? "running" : `waiting #${j.pos} in this session`, "aria-label": j.state === "running" ? "running" : `waiting #${j.pos}` }, j.state === "running" ? el("span", { class: "spin", "aria-hidden": "true" }) : [mui("HourglassEmpty", { class: "st-queued" }), String(j.pos)]),   // running is a spinner (2026-10-18 "▶ make this a spinner")
    el("span", { class: "qtx" }, one && g.k.startsWith("s:") ? lead(g.name) : shared && j.title && j.text && j.text !== j.title ? lead(j.title) : null, ...withQuotes(j)),   // the task name only when it says more than the text
    el("span", { class: "qmeta" }, agentMark(j.agent), j.state === "running" ? el("span", { class: "qup", "data-started": String(j.started || "") }, ` · ${since(j.started)}`) : null),
    dots(j.id)); };
  const sess = (k, name, tip, n) => el("div", { class: `qsess${SFOLD.has(k) ? " shut" : ""}`, "data-sess": k, role: "button", tabindex: "0", title: `${name}\n${tip} ― click to fold or unfold` }, el("span", { class: "qsn" }, name), el("span", { class: "n" }, `· ${n}`));   // the name cut with … on one line, the count always shown
  // a row of 👀 / ✅: t is the task it opens; ids the tasks ✓ Mark done / ↩ To review acts on (a folded session: all of its tasks in this section)
  const turn = (sec, t) => sec === "check" && t.asks;   // the agent asked and waits for your answer
  const prow = (sec, t, ids, o = {}) => el("div", { class: `qrow ended${turn(sec, t) ? " asks" : ""}${o.inner ? "" : " solo"}${DEST && ids.includes(DEST.id) ? " open" : ""}${ids.includes(HILITE) ? " hit" : ""}`, "data-task": t.id, "data-title": t.title,
      "data-status": sec, "data-ids": ids.join(" "), role: "button", tabindex: "0", title: `${o.tip ? `${o.tip}\n` : ""}${t.title} ― ${turn(sec, t) ? "the agent asked you something and waits for your answer: click, read its last reply and answer in ③" : "click to open this task's conversation"}` },
    tw(t), turn(sec, t) ? el("span", { class: "qst", title: "Waiting for your answer", "aria-label": "waiting for your answer" }, el("span", { class: "spin held", "aria-hidden": "true" }), mui("MarkChatUnread"))
      : endMark(t.job), el("span", { class: "qtx" }, lead(o.name), t.title),
    o.n ? el("button", { type: "button", class: "qn", "data-act": "unfold", "data-sess": o.key, "aria-expanded": String(SOPEN.has(o.key)), title: `${o.n} tasks in this session ― click to list them all` }, mui(SOPEN.has(o.key) ? "ArrowDropDown" : "ArrowRight"), String(o.n)) : null,
    el("span", { class: "qmeta", title: new Date(t.last * 1000).toLocaleString() }, t.agent ? [agentMark(t.agent), ` · ${ago(t.last)}`] : ago(t.last)),
    sec === "check" ? el("button", { type: "button", class: "qclose", "data-act": "close", "data-task": t.id, title: "Close ― mark this one task done (✅ Done › … › ↩ brings it back)", "aria-label": `Close: ${t.title}` }, mui("Check")) : null, dots(""));   // one task at a time (2026-10-24 "let Your turn close one task at a time")
  const tw = (t) => (t.turns > 1 ? el("button", { type: "button", class: "qtw", "data-act": "thread", "data-task": t.id, "aria-expanded": String(TOPEN.has(t.id)), title: `${t.turns} messages in this thread ― click to ${TOPEN.has(t.id) ? "fold them" : "list them here"}`, "aria-label": `${t.turns} messages` }, mui(TOPEN.has(t.id) ? "ArrowDropDown" : "ArrowRight"))
    : el("span", { class: "qtw", "aria-hidden": "true" }));   // keeps the column where ▸ goes
  const thread = (t) => (TOPEN.has(t.id) && t.turns > 1 ? (THREADS.get(t.id)?.jobs || []).map((j, i, js) => el("div", { class: "qrow qjob", "data-task": t.id, "data-title": t.title, "data-jid": j.id, role: "button", tabindex: "0",
      title: `${fullText(j)}${j.reply ? `\n――\n${short(String(j.reply).trim(), 300)}` : ""}` },   // on hover: the instruction and the head of its reply
    el("span", { class: "qst", title: `${i + 1} of ${js.length}: ${j.state}` }, `${i + 1}/${js.length}`, j.state === "queued" ? mui("HourglassEmpty", { class: "st-queued" }) : endMark(j.state, "qjm")), el("span", { class: "qtx" }, String(j.text || "").trim().split("\n")[0] || "(empty)"),
    el("span", { class: "qmeta", title: new Date((j.ended || j.ts) * 1000).toLocaleString() }, ago(j.ended || j.started || j.ts)))) : []);
  const head = (sec, n, extra) => el("div", { class: `qsess qsec ${sec}${SFOLD.has(sec) ? " shut" : ""}`, "data-sess": sec, role: "button", tabindex: "0", title: `${SECTION[sec][1]} ― click to fold or unfold` },
    mui(SECICON[sec]), el("span", { class: "qsn" }, SECTION[sec][0]), el("span", { class: "n" }, `· ${n}`), extra);
  const ends = (sec, bs, n) => {
    if (!n) return [];
    const shown = bs.slice(0, MORE[sec]), rest = bs.length - shown.length;
    return [head(sec, n, sec === "check" ? el("button", { type: "button", class: "qall", "data-act": "alldone", title: `Mark all ${n} as done`, "aria-label": `Mark all ${n} as done` }, mui("DoneAll")) : null),
      ...(SFOLD.has(sec) ? [] : [...shown.flatMap((g) => {
        const key = `${sec}:${g.k}`, ids = g.tasks.map((t) => t.id), open = g.tasks.length > 1 && SOPEN.has(key);
        return [prow(sec, g.tasks[0], open ? [g.tasks[0].id] : ids, { name: g.name, tip: g.tip, n: g.tasks.length > 1 ? g.tasks.length : 0, key }), ...thread(g.tasks[0]),
          ...(open ? g.tasks.slice(1).flatMap((t) => [prow(sec, t, [t.id], { inner: true }), ...thread(t)]) : [])];
      }), ...(rest > 0 ? [el("button", { type: "button", class: "qmore", "data-act": "more", "data-sec": sec }, `… ${Math.min(PAST_STEP, rest)} more (of ${rest})`)] : [])])];
  };
  $("#tall").setAttribute("aria-pressed", String(!DEST));   // 🧭 All is the icon left of ✕ (2026-10-18 "show the ALL button as an icon next to ✕" ― was the first row of the list)
  const had = document.activeElement?.closest?.("#board .qrow"), hk = had && (had.dataset.job ? `[data-job="${CSS.escape(had.dataset.job)}"]` : `[data-task="${CSS.escape(had.dataset.task)}"]`);   // the focused row keeps the focus through the redraw (Alt+↑/↓ moves on from it)
  $("#board").replaceChildren(
    head("live", q.length),
    ...(SFOLD.has("live") ? [] : q.length ? [...groups.values()].flatMap((g) => g.jobs.length === 1 && g.jobs[0].state === "running"   // nothing waits in it: one row
      ? [row(g.jobs[0], g, true)]
      : [sess(g.k, g.name, g.tip, g.jobs.length), ...(SFOLD.has(g.k) ? [] : g.jobs.map((j) => row(j, g, false)))])
      : [el("p", { class: "fhint" }, "Nothing runs or waits. What you send queues here, bundled by session.")]),
    ...ends("check", check, nCheck), ...ends("done", done, nDone));
  if (hk) document.querySelector(`#board .qrow${hk}`)?.focus({ preventScroll: true });
  const m = $("#qmenu");   // an open … menu follows its row through the redraw (a running job redraws the list at every step)
  if (m && !m.hidden && m._btn && !m._btn.isConnected) {
    const nb = [...document.querySelectorAll("#board .qdots")].find((b) => b.closest(".qrow").dataset.task === m._row && (b.dataset.job || "") === (m._btn.dataset.job || ""));
    if (nb) { m._btn = nb; nb.setAttribute("aria-expanded", "true"); nb.closest(".qrow").classList.add("menu"); placeMenu(); } else closeRowMenu();
  }
}
// Closing in 👀 moves you on (2026-10-24 "in Your turn, after one Done, switch to the message of the next highlighted task"): the row that
// took the closed one's place (or the one above, when it was the last) opens below. Only when the closed task was the one open (or 🧭 All
// was shown): closing another row while reading one does not pull you away
const reviewRows = () => [...document.querySelectorAll("#board .qrow.ended[data-status=check]")];
function nextReview(at, ids) {
  if (at < 0 || (DEST && !ids.includes(DEST.id))) return;
  const rows = reviewRows(), r = rows[Math.min(at, rows.length - 1)];
  if (!r) return openView(null);   // 👀 is empty: back to 🧭 All
  HILITE = ""; openView({ id: r.dataset.task, title: r.dataset.title || r.dataset.task }); showLog();
  document.querySelector(`#board .qrow.ended[data-status=check][data-task="${CSS.escape(r.dataset.task)}"]`)?.focus({ preventScroll: true });
}
async function markTasks(ids, status) {   // ✓ Mark done / ↩ To review: one task at a time (the store takes one per request)
  for (const id of ids) await api(`api/tasks/${encodeURIComponent(id)}`, { status });
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
const dots = (jid) => el("button", { type: "button", class: "qdots", "data-act": "menu", "data-job": jid || null, title: "Quote, stop, edit…", "aria-label": "Actions", "aria-haspopup": "menu", "aria-expanded": "false" }, mui("MoreHoriz"));
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
  const ids = (r.dataset.ids || "").split(" ").filter(Boolean), many = ids.length > 1 ? ` (${ids.length})` : "";   // a row of 👀 / ✅: what ✓ / ↩ acts on
  const acts = [...(j ? jobActs(j) : [{ how: "quote", icon: "📎", label: "Quote", tip: "Quote this task in ③", go: () => addQuotes([{ label: r.dataset.title || tid, text: "", task: tid }]) }]),
    ...(r.dataset.status === "check" ? [{ how: "done", icon: "✓", label: `Mark done${many}`, tip: "Looked at: move it to ✅ Done", go: async () => { const at = reviewRows().indexOf(r); await markTasks(ids, "done"); await drawTasks(); nextReview(at, ids); } }]
      : r.dataset.status === "done" ? [{ how: "review", icon: "↩", label: `Back to review${many}`, tip: "Move it back to 👀 To review", go: () => markTasks(ids, "doing") }] : [])];
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
// The heading row works like 📂 Files': ✕ folds and turns into ▾, which opens it again (no ⤢ here: 2026-10-18 "no ⤢ on Tasks" ― the line below moves the height)
// (the 📋 Tasks title itself does not fold: 2026-10-18 "no folding by clicking the word Tasks")
function foldTasks(on) {
  $("#tpane").classList.toggle("folded", on); LS.aetherTfold = on ? "1" : "0";
  const c = $("#tclose"); c.setAttribute("aria-expanded", String(!on)); c.replaceChildren(mui(on ? "ArrowDropDown" : "Close"));
  c.title = on ? "Open the task list" : "Fold the task list to one line (the arrow opens it again)"; c.setAttribute("aria-label", on ? "Open the task list" : "Fold the task list");
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
// Drag a waiting row up or down inside its session to change the order it runs in (2026-10-20 "reorder the Tasks queue by drag and drop").
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
let JUMP = "";   // the job a thread row was clicked for: sync scrolls to it after drawing the task's conversation
function toJob(jid) {   // the conversation scrolls to that message (instruction and reply flash). false: it is not drawn
  const b = document.querySelector(`#log .msg.bot[data-jid="${CSS.escape(jid)}"]`);
  if (!b) return false;
  const at = b._me || b; at.scrollIntoView({ block: "start" });
  document.querySelectorAll("#log .msg.flash").forEach((x) => x.classList.remove("flash"));
  void at.offsetWidth; at.classList.add("flash"); b.classList.add("flash");
  return true;
}
function tasksEvents() {
  queueDrag();
  const go = async (e) => {
    if (QSWALLOW) return;   // the click a drop leaves behind
    const act = e.target.closest("button[data-act]");
    if (act && act.dataset.act === "more") { MORE[act.dataset.sec] += PAST_STEP; return drawTasks(); }
    if (act && act.dataset.act === "close") {   // ✓ on a row of 👀: that task alone goes to ✅ Done (a folded session's row: its newest task; the next one takes the row)
      const row = act.closest(".qrow"), at = reviewRows().indexOf(row);
      act.disabled = true; row.classList.add("closing");
      try { await markTasks([act.dataset.task], "done"); } catch (err) { alert(`❌ ${err.message}`); return drawTasks(); }
      await drawTasks(); return nextReview(at, [act.dataset.task]);
    }
    if (act && act.dataset.act === "thread") { const k = act.dataset.task; TOPEN.has(k) ? TOPEN.delete(k) : TOPEN.add(k); LS.aetherThreadOpen = JSON.stringify([...TOPEN].slice(-50)); return drawTasks(); }
    if (act && act.dataset.act === "unfold") { const k = act.dataset.sess; SOPEN.has(k) ? SOPEN.delete(k) : SOPEN.add(k); LS.aetherSessOpen = JSON.stringify([...SOPEN]); return drawTasks(); }
    if (act && act.dataset.act === "alldone") {   // 👀 To review › ✓ all: everything in it is marked done (one confirm)
      const ids = (await api("api/tasks?all=1")).filter((t) => t.status !== "done" && ENDED.concat("").includes(t.job)).map((t) => t.id);
      if (!ids.length || !confirm(`Mark all ${ids.length} tasks in To review as done?`)) return;
      act.disabled = true; act.textContent = "…";
      try { await markTasks(ids, "done"); } catch (err) { alert(`❌ ${err.message}`); }
      return drawTasks();
    }
    if (act) return rowMenu(act);   // …: the whole job is read first (the queue carries its first line only)
    const sh = e.target.closest(".qsess");
    if (sh) { const id = sh.dataset.sess; SFOLD.has(id) ? SFOLD.delete(id) : SFOLD.add(id); LS.aetherSessFold = JSON.stringify([...SFOLD]); return drawTasks(); }
    const r = e.target.closest(".qrow"); if (!r) return;
    const same = DEST && DEST.id === r.dataset.task && $("#log").firstChild;   // already open: no redraw comes, so it scrolls now
    JUMP = r.dataset.jid || "";
    HILITE = ""; openView({ id: r.dataset.task, title: r.dataset.title || r.dataset.task }); showLog();
    if (same && JUMP) { toJob(JUMP); JUMP = ""; }
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
// ⌘/Ctrl + click adds or drops a row, Shift + click / Shift + ↑↓ takes a range; 📎 n in the header quotes them all in ③
// (2026-10-24 "multi-select in EXPLORER with Shift or Cmd (Ctrl)" → "paste into the chat"). A plain click, ↑↓ or Esc ends it.
const PICK = new Map();   // path → row ({path, dir, app?}) picked with a modifier; empty = the open one is the selection
let ANCHOR = "";
// the mark of a file type: one Material icon in one colour (2026-10-24 ―― until then a coloured letter per type)
const EXT = { md: "Article", txt: "Article", log: "Article", pdf: "PictureAsPdf", pptx: "Slideshow", key: "Slideshow", docx: "Description", xlsx: "TableChart", csv: "TableChart",
  json: "DataObject", yaml: "Settings", yml: "Settings", toml: "Settings", py: "Code", js: "Code", ts: "Code", html: "Code", css: "Code", sh: "Terminal",
  png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image", svg: "Image", mp4: "Movie", mov: "Movie", webm: "Movie", mp3: "AudioFile", wav: "AudioFile", m4a: "AudioFile" };
const extOf = (name) => (name.match(/\.([^./]+)$/) || ["", ""])[1].toLowerCase();
const icon = (name) => el("span", { class: "ic" }, mui(EXT[extOf(name)] || "InsertDriveFile"));
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
    const sel = PICK.size ? PICK.has(r.path) : CUR && r.path === CUR.path;
    out.push(el("div", { class: `frow${r.dir ? " dir" : ""}${sel ? " sel" : ""}${r.path === FOCUS ? " focus" : ""}`, "aria-selected": PICK.size ? String(sel) : null, role: "treeitem", "data-path": r.path, title: r.path, "aria-expanded": r.dir ? String(open) : null },
      ...Array.from({ length: depth }, () => el("span", { class: "ig" })), el("span", { class: "tw" }), r.dir ? (r.app ? el("span", { class: "fapp" }, "🧩") : null) : icon(r.name), el("span", { class: "nm" }, r.name), star(isFav(r.path))));
    out[out.length - 1]._r = r;
    if (open) walk(r.path, depth + 1);
  });
  walk("", 0);
  $("#frows").replaceChildren(...(out.length ? out : [el("p", { class: "fhint" }, "Empty folder.")]));
  $("#frows").setAttribute("aria-multiselectable", "true");
  const b = $("#fpick");
  b.hidden = !PICK.size;
  if (PICK.size) { b.replaceChildren(...lead(`📎 ${PICK.size}`)); b.title = b.ariaLabel = `Quote the ${PICK.size} selected in ③ (Esc: clear the selection)`; }
  drawFav();
}
// ★ Favorites: rows starred in the tree stay listed above it (2026-10-25 "favorites in the EXPLORER"). Kept in this browser per workspace,
// like the open folders. Only the path is kept: an app's manifest is read fresh when it opens. A star whose file has gone stays, greyed, until unstarred
let FAV = [];   // [{path, dir}] of this workspace, in the order starred
const GONE = new Set();
const favAll = () => { try { return JSON.parse(LS.aetherFav || "{}"); } catch { return {}; } };
const favLoad = () => { FAV = favAll()[INFO.workspace_path] || []; };
const isFav = (p) => FAV.some((f) => f.path === p);
const star = (on) => el("button", { type: "button", class: `fstar${on ? " on" : ""}`, tabindex: "-1", title: on ? "Remove from favorites" : "Add to favorites", "aria-label": on ? "Remove from favorites" : "Add to favorites", "aria-pressed": String(on) }, mui(on ? "Star" : "StarBorder"));
function favToggle(r) {
  FAV = isFav(r.path) ? FAV.filter((f) => f.path !== r.path) : [...FAV, { path: r.path, dir: !!r.dir }];
  GONE.delete(r.path);
  const all = favAll();
  if (FAV.length) all[INFO.workspace_path] = FAV; else delete all[INFO.workspace_path];
  LS.aetherFav = JSON.stringify(all); drawTree();
}
function drawFav() {
  const box = $("#ffav"); box.hidden = !FAV.length;
  box.replaceChildren(...(FAV.length ? [el("div", { class: "fx-sub" }, mui("Star"), "FAVORITES")] : []), ...FAV.map((f) => {
    const name = f.path.split("/").pop(), gone = GONE.has(f.path);
    return el("div", { class: `frow ffrow${f.dir ? " dir" : ""}${gone ? " gone" : ""}${CUR && CUR.path === f.path ? " sel" : ""}`, role: "treeitem", "data-path": f.path, title: gone ? `${f.path} (no longer there)` : f.path },
      f.dir ? el("span", { class: "ic" }, mui("Folder")) : icon(name), el("span", { class: "nm" }, name), el("span", { class: "fwhere" }, parent(f.path)), star(true));
  }));
}
async function favOpen(path) {   // the row as its folder lists it now
  const r = ((await kids(parent(path)).catch(() => null))?.items || []).find((x) => x.path === path);
  if (!r) { GONE.add(path); return drawFav(); }
  GONE.delete(path); pickClear(); ANCHOR = path;
  await openRow(r); reveal(path).catch(() => {});
}
const shown = () => [...document.querySelectorAll("#frows .frow")];
function pickToggle(row) {   // ⌘/Ctrl + click: the row the person was on comes along, as in VS Code
  const at = shown().find((x) => x.dataset.path === FOCUS);
  if (!PICK.size && at && at !== row) PICK.set(at.dataset.path, at._r);
  PICK.has(row.dataset.path) ? PICK.delete(row.dataset.path) : PICK.set(row.dataset.path, row._r);
  ANCHOR = FOCUS = row.dataset.path; drawTree();
}
function pickRange(to) {   // Shift: from the anchor (the last row clicked) to this one, in the order the tree shows
  const rows = shown(), b = rows.findIndex((x) => x.dataset.path === to);
  let a = rows.findIndex((x) => x.dataset.path === (ANCHOR || FOCUS));
  if (b < 0) return;
  if (a < 0) a = b;
  ANCHOR = rows[a].dataset.path; PICK.clear();
  rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => PICK.set(x.dataset.path, x._r));
  FOCUS = to; drawTree(); toFocus();
}
function pickClear() { if (!PICK.size) return false; PICK.clear(); drawTree(); return true; }
function quotePick() {   // in the tree's order; a row inside a folder since closed keeps its place at the end
  const at = new Map(shown().map((x, i) => [x.dataset.path, i])), rows = [...PICK.values()];
  rows.sort((p, q) => (at.get(p.path) ?? 1e9) - (at.get(q.path) ?? 1e9));
  addQuotes(rows.map((r) => (r.dir ? folderQuote(r.path, r.app) : { label: `📄 ${r.path}`, text: "", path: r.path })));
  pickClear();
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
      .map((o) => ({ head: o.head != null ? str(o.head, 24) : null, value: str(o.value, 60), label: str(o.label, 24), icon: str(o.icon, 40), title: str(o.title, 200) || null, full: "full" in o ? !!o.full : !!x.full }));
    const label = str(x.label, 24), title = str(x.title, 200) || null, off = x.disabled ? "" : null;
    const words = (t, ic) => (ic && MUI[ic] ? [mui(ic, { class: t ? "lead" : "" }), t] : t);   // "icon": a Material name (spec §3.1) ―― a head emoji in the label works too
    if (x.select) return el("label", { class: "fsel", title }, label || x.icon ? el("span", { class: "lbl" }, words(label, str(x.icon, 40))) : null,
      el("select", { "aria-label": label || title || x.id, disabled: off, onchange: (e) => fire(x, e.target.value, false) }, ...opts.filter((o) => o.head == null).map((o) => el("option", { value: o.value, title: o.title, selected: o.value === str(x.value, 60) ? "" : null }, o.label))));
    const main = fbtn(words(label, str(x.icon, 40)) || x.id, () => fire(x), { title, disabled: off, class: x.primary ? "primary" : null, "aria-label": title && !/\p{L}/u.test(label) ? title : null });   // an icon-only label (📎) is named by its title
    if (!opts.length) return main;
    const menu = el("div", { class: "fmenu", role: "menu", hidden: "" }, ...opts.map((o) => (o.head != null ? el("div", { class: "fmhead", role: "presentation" }, o.head)
      : fbtn([el("span", { class: "fml" }, words(o.label, o.icon)), o.title ? el("small", {}, o.title) : null], () => { menu.hidden = true; fire(x, o.value, o.full); }, { role: "menuitem" }))));
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
const folderQuote = (path, app) => ({ label: `${app ? "🧩" : "📁"} ${path}/`, text: "", path, rules: app && app.rules ? `${path}/${app.rules}` : "" });
const quoteFolder = (path, app) => addQuotes([folderQuote(path, app)]);
const absPath = (path) => (path ? `${INFO.workspace_path}/${path}` : INFO.workspace_path);   // to paste into a terminal or another chat
const zipName = (path) => `${path.split("/").pop()}.folder.zip`;
// An app or an extension that uses files outside its folder (../, an absolute path, a link out) would not run from its zip: the person
// sees them first and may still take it (2026-10-24 "check what an app or an extension depends on before it is downloaded"), or 📥 have
// the agent copy them in: a prompt lands in ③ with the folder quoted, for the person to read and send (2026-10-24 "a button to bring them in")
const depLine = (d) => `${d.target}  ← ${d.file}${d.ref.startsWith("link") ? "" : ` (${d.ref})`}${d.more ? ` +${d.more} more` : ""}`;
function depAsk(path, deps) {   // → "take" · "dl" · anything else: no
  const d = $("#depdlg"), name = path.split("/").pop(), n = `${deps.length}${deps.length >= 50 ? "+" : ""}`;
  $("#depwhat").textContent = `“${name}” uses ${n} file${deps.length > 1 ? "s" : ""} outside its folder. Its ${zipName(path)} will not hold them, so it may not run elsewhere.`;
  $("#deplist").replaceChildren(...deps.map((x) => el("li", {}, el("code", {}, x.target), " ← ", x.file, x.more ? el("small", {}, ` +${x.more} more`) : null)));
  return new Promise((done) => { d.onclose = () => done(d.returnValue); d.returnValue = ""; d.showModal(); $("#depno").focus(); });   // the safe choice has the focus
}
function depTake(path, app, deps) {
  addQuotes([folderQuote(path, app)]);   // puts @n where the cursor of ③ is
  const ta = $("#say"), at = ta.selectionStart, kind = app ? "app" : "extension";
  const text = `← this ${kind} uses ${deps.length >= 50 ? "50 or more" : deps.length} file${deps.length > 1 ? "s" : ""} outside its folder, so its ${zipName(path)} would not run elsewhere. Bring them in:
- copy each one into the folder (a subfolder such as vendor/ or shared/ is fine), and point the code at the copy with a path relative to the folder (no ../, no absolute path)
- leave the originals where they are
- do not copy a whole project, a large folder, a venv or cache, or another program's data: list those and ask me instead
- then check that it still runs, and that nothing in it points outside its folder

${deps.map((d) => `- ${depLine(d)}`).join("\n")}
`;
  ta.value = LS.aetherDraft = ta.value.slice(0, at) + text + ta.value.slice(at);
  ta.focus(); ta.selectionStart = ta.selectionEnd = at + text.length; growSay();
}
async function zipGet(path, app, history = true) {   // the name in the URL and in download too: a relay that drops Content-Disposition would save it as "zip" (2026-10-24)
  const h = history ? "" : "&history=0";   // without the app's past data and venvs: what is checked is what the zip holds
  const deps = (await api(`api/zipdeps?path=${encodeURIComponent(path)}${h}`)).deps;
  const how = deps.length ? await depAsk(path, deps) : "dl";
  if (how === "take") return depTake(path, app, deps);
  if (how !== "dl") return;
  const a = el("a", { href: `api/zip/${encodeURIComponent(zipName(path))}?path=${encodeURIComponent(path)}&force=1${h}`, download: zipName(path) });
  document.body.append(a); a.click(); a.remove();
}
// An app that names its past data (aether.json "history") gets ▾ at the edge of ⬇: with it, or without it and its venvs ―― to try the app
// elsewhere, where the venvs are made again (2026-10-25 "DLボタンの端をメニュー化して、過去データを含む、過去データを含まないを選べるように")
function zipBtn(path, app, attrs = {}) {
  const go = (history) => zipGet(path, app, history).catch((err) => alert(err.message));
  const main = fbtn("⬇", () => go(true), { class: "ficon", title: `Download this ${app ? "app" : "folder"} as ${zipName(path)}`, "aria-label": `Download this ${app ? "app" : "folder"} as zip`, ...attrs });
  if (!app || !(app.history || []).length) return main;
  const item = (id, words, small, history) => fbtn([el("span", { class: "fml" }, words), el("small", {}, small)], () => { menu.hidden = true; go(history); }, { role: "menuitem", id });
  const menu = el("div", { class: "fmenu fzipm", role: "menu", hidden: "" },
    item("fzipwith", "With past data", "everything in the folder", true),
    item("fzipwithout", "Without past data", `leaves out ${app.history.join(", ")} and venvs (made again where it goes)`, false));
  return el("span", { class: "fsplit" }, main, fbtn("▾", () => { const was = menu.hidden; document.querySelectorAll("#fbar .fmenu").forEach((m) => { m.hidden = true; }); menu.hidden = !was; },
    { class: "fmore", id: `${attrs.id || "fzip"}more`, "aria-haspopup": "menu", title: "Download with or without its past data", "aria-label": "Download with or without its past data" }), menu);
}
const copyPath = (path, attrs = {}) => copyBtn(() => absPath(path), `Copy the path: ${absPath(path)}`, { class: "ficon", ...attrs });
async function openDir(path) {
  const d = await api(`api/files?path=${encodeURIComponent(path)}`);
  KIDS.set(path, d); FRAME = null; setCur({ kind: "dir", path });
  const nd = d.items.filter((r) => r.dir).length, nm = d.items.filter((r) => !r.dir && mediaOf(r.name)).length;
  const grid = nm > 0 && (LS.aetherGrid ? LS.aetherGrid === "1" : nm * 2 >= d.items.length - nd);   // the person's pick, else thumbnails when half the files or more are media
  bar(path, ...(d.app ? [fbtn(`▶ Open ${d.app.label}`, () => openApp(path, d.app))] : []),
    path ? fbtn("📎", () => quoteFolder(path, d.app), { class: "ficon", id: "fquotedir", title: `Quote this ${d.app ? "app" : "folder"} in ③`, "aria-label": `Quote this ${d.app ? "app" : "folder"} in ③` }) : null,
    copyPath(path, { id: "fcopypath" }), path ? zipBtn(path, d.app, { id: "fzipdir" }) : null,
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
    fbtn("🔄", () => reloadFile(path, p), { class: "ficon", title: p && p.render ? "Reload ―― the file again, and its pages drawn again" : "Reload", "aria-label": "Reload" }));
  if (!p) { FRAME = null; return $("#fbody").replaceChildren(el("p", { class: "fhint fempty" }, `No preview extension for “${extOf(name) ? `.${extOf(name)}` : name}”. Quote it (`, mui("AttachFile", { class: "inl" }), ") to hand it to the agent.")); }
  frame(`x/${p.id}/${p.entry}`, name, async () => {
    try { post("open", { path, name, ...(o.top ? { top: o.top } : {}), state: xstate(p.id), ...(p.binary ? { data: await bytes(path) } : { text: (await api(`api/read?path=${encodeURIComponent(path)}`)).text }) }); }
    catch (err) { post("open", { path, name, error: err.message }); }
  }, p);
}
// 🔄 reads the file again where it was scrolled to (keeping ← →). A preview that draws pages (manifest "render", spec §3.2) gets them drawn again
// too: one button for both (2026-10-24 "merge Reload and the preview refresh"). The page shows the pages it has until the new ones come
async function reloadFile(path, p) {
  if (p && p.render) await api("api/render", { ext: p.id, path, force: true }).catch(() => {});   // not waited for: the page asks and waits itself
  const top = NAV.top;
  NAV.going = true;   // the ← → history stays: the same file, read again
  try { await openFile(path, { top }); } finally { NAV.going = false; }
}
const openRow = (r) => (r.app ? Promise.resolve(openApp(r.path, r.app)) : r.dir ? openDir(r.path) : openFile(r.path));   // clicking a folder that is an app runs it
function openApp(path, app) {
  setCur({ kind: "app", path, app });
  bar(path, el("span", { class: "fhint" }, `🧩 ${app.label}`), fbtn("📁 Contents", () => openDir(path), { title: "Show the files of this folder" }),
    fbtn("📎", () => quoteFolder(path, app), { class: "ficon", title: "Quote this app in ③", "aria-label": "Quote this app in ③" }), zipBtn(path, app, { id: "fzipapp" }),
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
  if (!up) return body.replaceChildren(el("p", { class: "fhint fempty" }, `🔌 ${src} does not answer. Start the program that serves “${app.label}”, then press `, mui("Refresh", { class: "inl" }), "."));
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
  favLoad();
  await kids("").catch(() => {}); await loadOpen(); drawTree();
  const c = CUR;
  if (c) (c.kind === "dir" ? openDir(c.path) : c.kind === "app" ? Promise.resolve(openApp(c.path, c.app)) : openFile(c.path)).then(() => view(false)).catch(empty);
  else empty();
}
function empty() { $("#fbar").replaceChildren(); $(".fmain").classList.remove("frame"); $("#fbody").replaceChildren(el("p", { class: "fhint fempty" }, "Pick a file in the explorer on the left to see it here.")); }
function filesEvents() {
  $("#frows").addEventListener("click", (e) => {
    const r = e.target.closest(".frow"); if (!r) return;
    if (e.target.closest(".fstar")) return favToggle(r._r);
    if (e.shiftKey) return pickRange(r.dataset.path);
    if (e.metaKey || e.ctrlKey) return pickToggle(r);
    pickClear(); ANCHOR = FOCUS = r.dataset.path;
    if (!r.classList.contains("dir")) return openFile(FOCUS);
    if (e.target.closest(".tw")) toggle(FOCUS); else openRow(r._r);   // the chevron opens and closes; the name shows the folder (an app folder runs the app)
  });
  $("#ftree").addEventListener("keydown", (e) => {
    const rows = [...document.querySelectorAll("#frows .frow")], i = rows.findIndex((r) => r.dataset.path === FOCUS), cur = rows[i];
    const go = (j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { PICK.clear(); ANCHOR = FOCUS = r.dataset.path; drawTree(); toFocus(); } };
    const grow = (j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { if (!PICK.size && cur) ANCHOR = FOCUS; pickRange(r.dataset.path); } };
    if (e.key === "Escape") { if (!pickClear()) return; }
    else if (e.shiftKey && e.key === "ArrowDown") grow(i + 1);
    else if (e.shiftKey && e.key === "ArrowUp") grow(i < 0 ? 0 : i - 1);
    else if (e.key === "Enter" && PICK.size) quotePick();
    else if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if (!cur) return;
    else if (e.key === "ArrowRight") { if (cur.classList.contains("dir")) (cur.getAttribute("aria-expanded") === "true" ? go(i + 1) : toggle(FOCUS, true)); }
    else if (e.key === "ArrowLeft") { if (cur.getAttribute("aria-expanded") === "true") toggle(FOCUS, false); else if (FOCUS.includes("/")) { FOCUS = parent(FOCUS); drawTree(); toFocus(); } }
    else if (e.key === " ") (cur.classList.contains("dir") ? toggle(FOCUS) : openFile(FOCUS));
    else if (e.key === "Enter") openRow(cur._r);
    else return;
    e.preventDefault();
  });
  $("#fpick").addEventListener("click", quotePick);
  $("#ffav").addEventListener("click", (e) => {
    const r = e.target.closest(".frow"); if (!r) return;
    if (e.target.closest(".fstar")) return favToggle({ path: r.dataset.path });
    favOpen(r.dataset.path);
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
  treeDrop();
  if (LS.aetherTreeW) $(".fx").style.setProperty("--fw", LS.aetherTreeW);
  new ResizeObserver(() => { const w = $("#app-files").clientWidth; if (w) $("#fbar").classList.toggle("narrow", w <= 560); }).observe($("#app-files"));
  new ResizeObserver(snapFrame).observe($("#fbody"));
}
// Files and folders dropped from the desktop onto the explorer are added to the workspace (2026-10-24 "add files by dragging them onto the EXPLORER").
// On a folder: into it (a closed one opens after a moment's hover); on a file: beside it; on the empty space: the workspace root.
// Nothing is replaced: a taken name becomes "name (2).ext". A file dropped anywhere else does nothing (the browser would leave the page for it).
// A "<name>.folder.zip" (what ⬇ makes) comes back unpacked as the folder <name> (2026-10-24 "unzip a dropped .folder.zip"); one that cannot be stays a zip.
const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
function dropDir(e) {
  const r = e.target.closest?.("#frows .frow");
  return !r ? "" : r.classList.contains("dir") ? r.dataset.path : parent(r.dataset.path);
}
async function dropped(items) {   // [{path: folder under the target, file}] from the entries (folders walked)
  const out = [], files = (entry, at) => new Promise((done) => entry.file((f) => { out.push({ path: at, file: f }); done(); }, () => done()));
  const walk = async (entry, at) => {
    if (entry.name === ".DS_Store") return;
    if (entry.isFile) return files(entry, at);
    const rd = entry.createReader(), sub = at ? `${at}/${entry.name}` : entry.name;
    for (let got; (got = await new Promise((ok) => rd.readEntries(ok, () => ok([])))).length;) for (const c of got) await walk(c, sub);   // readEntries gives 100 at a time
  };
  for (const it of items) await (it.entry ? walk(it.entry, "") : (out.push({ path: "", file: it.file }), null));
  return out;
}
async function upload(dir, items) {
  const head = $("#froot"), name = head.textContent, list = await dropped(items);
  let first = null, failed = [];
  for (const [i, { path, file }] of list.entries()) {
    head.replaceChildren(...lead(`⇪ ${i + 1} / ${list.length} ${short(file.name, 24)}`));
    const folder = [dir, path].filter(Boolean).join("/");
    try {
      const r = await fetch(`api/upload?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Aether": "1" }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      first ||= path ? `${dir ? `${dir}/` : ""}${path.split("/")[0]}` : j.path;
      if (j.unzip_error) failed.push(`${file.name}: added, but not unpacked (${j.unzip_error})`);
    } catch (err) { failed.push(`${file.name}: ${err.message}`); }
  }
  head.textContent = name;
  KIDS.clear(); await kids(""); await loadOpen();
  if (dir) await reveal(dir, true);
  if (first) { FOCUS = first; drawTree(); toFocus(); } else drawTree();
  if (CUR && CUR.kind === "dir" && CUR.path === dir) openDir(dir).catch(() => {});   // the folder on the right shows them too
  if (failed.length) alert(`Not added or not unpacked (${failed.length} of ${list.length}):\n${failed.slice(0, 10).join("\n")}`);
}
function treeDrop() {
  const tree = $("#ftree"), mark = (dir) => {
    document.querySelectorAll("#frows .fdrop").forEach((x) => x.classList.remove("fdrop"));
    tree.classList.toggle("fdrop", dir === "");
    if (dir) document.querySelector(`#frows .frow[data-path="${CSS.escape(dir)}"]`)?.classList.add("fdrop");
  };
  let hold = null, depth = 0;   // hold: {path, timer} the closed folder under the pointer; depth: dragenter/leave of the children
  const stop = () => { clearTimeout(hold?.timer); hold = null; depth = 0; mark(null); };
  tree.addEventListener("dragenter", (e) => { if (isFiles(e)) depth++; });
  tree.addEventListener("dragleave", (e) => { if (isFiles(e) && --depth <= 0) stop(); });
  tree.addEventListener("dragover", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    const dir = dropDir(e), r = e.target.closest?.("#frows .frow.dir");
    mark(dir);
    const closed = r && r.getAttribute("aria-expanded") !== "true" ? r.dataset.path : null;
    if (hold?.path !== closed) { clearTimeout(hold?.timer); hold = closed ? { path: closed, timer: setTimeout(() => toggle(closed, true), 700) } : null; }
  });
  tree.addEventListener("drop", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    const dir = dropDir(e), items = [...e.dataTransfer.items].filter((x) => x.kind === "file").map((x) => ({ entry: x.webkitGetAsEntry?.(), file: x.getAsFile() }));   // entries only live during the event
    stop();
    if (items.length) upload(dir, items).catch((err) => alert(err.message));
  });
  for (const n of ["dragover", "drop"]) document.addEventListener(n, (e) => { if (isFiles(e) && !e.defaultPrevented && !e.target.closest?.("#ftree")) e.preventDefault(); });
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
  else if (d.type === "render") {   // pages a preview's own command draws (manifest "render", spec §3.2): the core runs it, the shell hands the images over
    const ext = FRAME._ext, f = FRAME, fail = (error) => post("reply", { id: d.id, ok: false, error });
    if (!ext || o.kind !== "file") return fail("only a preview whose aether.json names render");
    try {
      const b = { ext: ext.id, path: o.path, force: d.force === true, wait: d.wait === true, page: +d.page || 0, width: +d.width || 0 };
      const r = await api("api/render", b);
      const img = (key, name) => fetch(`api/render/img?${new URLSearchParams({ ext: ext.id, path: o.path, key, name })}`).then((x) => (x.ok ? x.arrayBuffer() : null), () => null);
      const data = b.page ? await img(r.key, r.name) : await Promise.all((r.pages || []).map((n) => img(r.key, n)));
      if (FRAME !== f || CUR !== o) return;   // another file opened meanwhile
      f.contentWindow.postMessage({ aether: INFO && INFO.protocol, type: "reply", id: d.id, ok: true, ...r, data }, "*", (Array.isArray(data) ? data : [data]).filter(Boolean));
    } catch (err) { fail(err.message); }
  }
  else if (d.type === "fetch") {   // an app asks the shell to fetch from a server of its own (manifest "ports"): through a cookie-authenticated relay the sandboxed page's own requests carry no cookie
    const fail = (error) => post("reply", { id: d.id, ok: false, error });
    let u; try { u = new URL(String(d.url || "")); } catch { return fail("not a URL"); }
    const port = +u.port, mine = +(location.pathname.match(/\/proxy\/(\d+)\//)?.[1] || location.port);
    if (o.kind !== "app" || !LOOPBACK.test(u.href) || port === mine) return fail("apps may fetch only from the ports their aether.json names");
    const f = FRAME, ports = await (f._ports ||= api(`api/files?path=${encodeURIComponent(o.path)}`).then((x) => x.app?.ports || [], () => []));   // the manifest as it is now, once per frame: CUR comes back from localStorage as it was saved
    if (!ports.includes(port)) return fail("apps may fetch only from the ports their aether.json names");
    const method = d.method === "POST" ? "POST" : "GET", type = d.contentType ? { "Content-Type": String(d.contentType) } : {};
    const relay = /\/proxy\/\d+\//.test(location.pathname), near = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
    const via = relay || near ? appUrl(u.href) : `api/port/${port}${u.pathname}${u.search}`;   // another host (Cloud Shell's web preview…): 127.0.0.1 is not reachable from this browser, so the core fetches it
    const head = relay || near ? type : { ...type, "X-Aether": "1", "X-Aether-App": o.path };
    try {
      const r = await fetch(via, { method, headers: head, body: method === "POST" ? d.body : undefined, cache: "no-store", credentials: "include" });
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
  else if (d.type === "ui.reply" && UIQ.has(d.id)) { const r = UIQ.get(d.id); UIQ.delete(d.id); d.ok ? r.ok(d.result) : r.ng(new Error(d.error)); }   // 🖱 the framed page answered
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
  ta.addEventListener("blur", () => { CARET = [ta.selectionStart, ta.selectionEnd]; closeAt(); });
  ta.addEventListener("paste", pasteImages);
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
  $("#mic").addEventListener("click", micToggle);
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
    down(null);
    if (rev !== REV) {
      REV = rev; RELOADING = !!reloading;
      await sync();
      drawTasks();
      if (treeStale && filesUp) { treeStale = false; refreshTree().catch(() => {}); }
      post("rev", { rev });
    }
  } catch (err) { console.error(err); down(err); } finally { busy = false; }
}
// The core answers but cannot use its data (503 down: a full disk, 2026-10-25), or nothing answers: said in the header. Silent, the task list
// emptied and the titles looked broken
function down(err) {
  const w = $("#down");
  w.hidden = !err;
  if (err) { w.replaceChildren(...lead(`⚠ ${err.body?.down ? err.message : `The core does not answer (${err.message})`}`)); w.title = err.message; }
}
function wsDialog(required) {   // the workspace folder: asked on a fresh install (no cancel), changeable later unless --workspace fixed it
  const d = $("#wsdlg"), err = $("#wserr"), note = $("#wsnote"), inp = $("#wspath"), ok = $("#wsok");
  inp.value = INFO.workspace_path || ""; err.hidden = true;
  note.hidden = !(required || INFO.workspace_error);
  note.replaceChildren(...lead(INFO.workspace_error ? `⚠ ${INFO.workspace_error}` : "No workspace is set yet. Enter the folder to work in; it is saved for the next start."));
  $("#wscancel").hidden = required;
  d.oncancel = (e) => { if (required) e.preventDefault(); };   // Esc cannot skip the first setup
  $("#wscancel").onclick = () => d.close();
  const use = async (path) => {
    ok.disabled = true; err.hidden = true;
    try { await api("api/config", { workspace: path }); location.reload(); }   // everything (tree, extensions, open files) belongs to the old folder
    catch (x) { err.replaceChildren(...lead(`❌ ${x.message}`)); err.hidden = false; ok.disabled = false; inp.focus(); }
  };
  $("#wsform").onsubmit = (e) => { e.preventDefault(); use(inp.value); };
  const recent = INFO.recent || [];   // the folders used last (the core keeps them): one click switches
  $("#wsrecent").hidden = !recent.length;
  $("#wslist").replaceChildren(...recent.map((p) => {
    const at = p.lastIndexOf("/"), cur = p === INFO.workspace_path;
    return el("button", { type: "button", title: p, disabled: cur ? "" : null, onclick: () => use(p) },
      el("b", {}, p.slice(at + 1)), el("small", {}, el("bdi", {}, p.slice(0, at) || "/")), cur ? el("em", {}, "current") : null);
  }));
  const v = INFO.vertex || {};   // shown, never set here: the page is an API anyone on this machine can call (aether setup vertex, in a terminal)
  $("#wsvertex").hidden = false;
  $("#wsvtext").textContent = v.auth === "none" ? "Not set: agents use their own defaults" :
    `Project ${v.project} · ${v.region || "global"} · signed in with ${v.auth === "key" ? "a key file (the path stays in settings.json)" : "your own account (ADC)"}`;
  d.showModal(); inp.focus(); inp.select();
}
function iconizeStatic(root = document.body) {   // index.html's own words: a head emoji → its icon (once, before anything is drawn into it)
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement.closest("textarea, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) }), ts = [];
  while (w.nextNode()) ts.push(w.currentNode);
  for (const t of ts) {
    const v = t.nodeValue, i = v.search(/\S/), parts = i < 0 ? [] : lead(v.slice(i));
    if (parts.length && typeof parts[0] !== "string") t.replaceWith(v.slice(0, i), ...parts);
  }
}
async function start() {
  iconizeStatic();
  INFO = await api("api/info");
  $("#ver").textContent = `v${INFO.version}`;
  $("#ver").title = `AetherRSI ${INFO.version} · protocol ${INFO.protocol} · ${INFO.locked ? "core locked" : "core unlocked"} (${INFO.lock_reason})`;   // the lock is one hover away
  $("#fws").title = INFO.workspace_fixed ? `${INFO.workspace_path} (given at start with --workspace)` : `Change the workspace folder (now ${INFO.workspace_path || "not set"})`;
  $("#fws").disabled = INFO.workspace_fixed;
  $("#fws").onclick = () => wsDialog(false);
  if (!INFO.workspace) return wsDialog(true);   // nothing else works without a folder (the API answers 409)
  if (INFO.errors.length) { $("#warn").hidden = false; $("#warn").replaceChildren(...lead(`⚠ ${INFO.errors.length} extension(s) skipped`)); $("#warn").title = INFO.errors.join("\n"); }
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
  if (id && !t) bubble("bot", muiText("{Warning} The linked task was not found (deleted, or a wrong id). Showing {Explore} All."));
}
start().catch((e) => bubble("bot", `❌ Could not load: ${e.message}`));
