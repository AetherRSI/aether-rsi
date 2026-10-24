// md-preview: the Markdown preview of SoloGen v3's 📂 Files (apps/files/static/view.js), ported to an AetherRSI preview.
// Same blocks, units (Auto · Block · Sentence · Cell · Row · Column · Element), mermaid figures, ```html ui screens, links, ⬇ download | 🖨 print, ▶ present | PDF.
// What changed is only the way out: quotes go through aether.quote, links through aether.open (the shell keeps ← →),
// the bar items through aether.bar (they sit next to the shell's 📎 🔄), and the unit is remembered with aether.save.
(() => {
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
const btn = (label, fn, attrs = {}) => { const b = el("button", Object.assign({ type: "button" }, attrs), label); b.addEventListener("click", fn); return b; };
const parent = (p) => p.split("/").slice(0, -1).join("/");
const ICON = { md: "📝" };
const QUOTE_MAX = 20000;   // the body of one quote (characters). Longer ones are cut at a line break
const FV = { unit: "blk" };
let SEL = null;   // the open file and what is picked {f: {path, name, kind, text}, items: [{t:"sent"|"cell"|"row"|"col"|"elem",key,blk,node,c}], last}
const addQuotes = (qs) => qs.forEach((q) => aether.quote(SEL && q.label.startsWith(`${SEL.f.name} `) ? q.label.slice(SEL.f.name.length + 1) : q.label, q.text));   // the shell already puts "📄 path ·" in front
const unfull = () => (aether.fullscreen ? aether.fullscreen(false) : parent.postMessage({ aether: "0.1", type: "fullscreen", on: false }, "*"));

// Look of the slides. "simple" is built in. More looks are local folders tpl/<name>/ listed in tpl/list.json (not shipped:
// a company template carries its logo). tpl/<name>/tpl.json = {label, play, pdf, conf, copy, cover, logo} and tpl/<name>/tpl.css
const TPLS = { simple: { label: "Simple", play: "Blue headings on white, full screen", pdf: "One slide per page as PDF (destination: Save as PDF)" } };
let TPL_MAIN = "simple";   // the ▶ button: the first local look if there is one (SoloGen v3 plays the company template by default)
const tplsP = (async () => {
  let names = [];
  try { names = JSON.parse(await aether.read("tpl/list.json")); } catch { return; }
  for (const n of (Array.isArray(names) ? names : []).filter((x) => /^[\w-]+$/.test(x))) {
    try {
      TPLS[n] = JSON.parse(await aether.read(`tpl/${n}/tpl.json`));
      document.head.append(el("style", { "data-tpl": n }, await aether.read(`tpl/${n}/tpl.css`).catch(() => "")));
      if (TPL_MAIN === "simple") TPL_MAIN = n;
    } catch { /* a broken look is left out */ }
  }
})();

// The bar (spec §3.1): ⬇ Download ▾ · ▶ Present ▾ · Unit · 📎 Add n to quotes · Clear
const UNITS = { auto: "Auto", blk: "Block", sent: "Sentence", cell: "Cell", row: "Row", col: "Column", elem: "Element" };
const PART = { sent: ".sn", cell: "table.mdt td, table.mdt th", row: "table.mdt td, table.mdt th", col: "table.mdt td, table.mdt th", elem: ".mfig .mel" };
const UNIT_TIP = { auto: "Shows chips for the units you can pick here (Sentence, Cell, Row, Column, Element, Block) and their range where the mouse is", blk: "Whole blocks (Shift for a range)", elem: "Click a node, line or group in a Mermaid diagram, or an element of an HTML screen, to pick that element (the diagram background and non-diagrams pick the whole block)" };
function drawBar() {
  if (!SEL) return aether.bar([]);
  const f = SEL.f, n = picked().length;
  const pres = (v) => { const [t, how] = (v || `${TPL_MAIN}:play`).split(":"); return how === "pdf" ? presentPdf(f, t) : present(f, t); };
  aether.bar([
    { id: "dl", icon: "Download", label: "Download", title: `Download ${f.name}`, run: (v) => (v === "print" ? printView(f) : aether.download()),
      options: [{ value: "dl", icon: "Download", label: "Download", title: "Save the original file as is" }, { value: "print", icon: "Print", label: "Print (PDF)", title: "Print the current preview (destination: Save as PDF)" }] },
    { id: "present", icon: "Slideshow", label: "Present", full: true, title: `Full screen in ${TPLS[TPL_MAIN].label} — ← → to move, Esc to exit (▾ to choose the look or PDF)`, run: pres,
      options: Object.entries(TPLS).flatMap(([t, x]) => [{ head: x.label },
        { value: `${t}:play`, icon: "PlayArrow", label: "Play", title: x.play, full: true }, { value: `${t}:pdf`, icon: "Print", label: "PDF", title: x.pdf, full: false }]) },
    { id: "unit", label: "Unit", select: true, value: FV.unit, title: "Choose the unit to quote", run: setUnit,
      options: Object.entries(UNITS).map(([k, v]) => ({ value: k, label: v, title: UNIT_TIP[k] || `Quote the ${v.toLowerCase()} you click (blocks other than tables are quoted whole)` })) },
    ...(n ? [{ id: "quote", icon: "AttachFile", label: `Add ${n} to quotes`, primary: true, title: `Add the ${n} picked to the quotes in ③`, run: quotePicked },
      { id: "clear", label: "Clear", run: clearSel }] : []),
  ]);
}
function setUnit(k) {
  if (!UNITS[k]) return;
  FV.unit = k;
  aether.save({ unit: k });
  autoHide();
  const d = $("#fbody .fdoc");
  if (d) d.className = `fdoc md u-${k}`;
}

let scrollT = 0;
$(".fmain").addEventListener("scroll", () => { clearTimeout(scrollT); scrollT = setTimeout(() => aether.scrolled($(".fmain").scrollTop), 150); }, { passive: true });
aether.on("scroll.to", (d) => { $(".fmain").scrollTop = +d.top || 0; });
aether.on("open", async (d) => {
  const body = $("#fbody");
  if (d.state && UNITS[d.state.unit]) FV.unit = d.state.unit;
  if (d.error) { SEL = null; drawBar(); body.replaceChildren(el("p", { class: "ferr" }, mui("Cancel", { class: "lead" }), d.error)); return; }
  const f = { path: d.path, abs: d.path, name: d.name, kind: "md", text: (d.text || "").replace(/\r\n?/g, "\n") };
  SEL = { f, items: [], last: null };
  body.replaceChildren(el("div", { class: `fdoc md u-${FV.unit}` }, ...blocks(f.text, "md")));
  drawBar();
  if (d.top) $(".fmain").scrollTop = d.top;
  await tplsP;
  if (SEL?.f === f) drawBar();   // the local looks are in the ▶ menu now
});
aether.on("fullscreen", (d) => { if (!d.on) document.querySelector(".pdeck:not(.pmeasure)")?.closeDeck?.(); });

// ―― md → blocks, links, mermaid, sentences (as SoloGen v3) ――
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// Links (2026-10-17 "make hyperlinks clickable"): [text](URL) and bare http(s)://… in the text become clickable a.flink.
//   Outside (http, https, mailto) opens a new tab; a relative path opens that file (folder) in this tab; #heading scrolls to that heading. Other schemes (javascript: etc.) are only underlined
const flink = (t, u) => /^[a-z][\w+.-]*:/i.test(u) && !/^(https?|mailto):/i.test(u) ? `<u>${t}</u>`
  : `<a class="flink" href="${u}" title="${u}"${/^(https?|mailto):/i.test(u) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${t}</a>`;
// Images (2026-10-24 "images aren't showing?"): ![text](relative path) resolves from this file's folder and loads from the shell's files/ (this page lives at x/<id>/).
//   Outside images (http etc.) are not loaded, as in htmlFig; they become links. <br> (<br/>) inside tables becomes a line break
const fimg = (t, u) => {
  if (/^([a-z][\w+.-]*:|\/\/)/i.test(u)) return flink(t || u, u);
  let p; try { p = decodeURI(u.replace(/&amp;/g, "&").split("#")[0]); } catch { p = u.split("#")[0]; }
  const out = p.startsWith("/") ? [] : parent(SEL?.f.path || "").split("/").filter(Boolean);
  for (const x of p.split("/")) { if (x === "..") out.pop(); else if (x && x !== ".") out.push(x); }
  return `<img class="fimg" src="../../files/${out.map(encodeURIComponent).join("/")}" alt="${t}" title="${t}" loading="lazy">`;
};
const inline = (s) => esc(s).replace(/&lt;br\s*\/?&gt;/gi, "<br>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, t, u) => fimg(t, u))
  .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, t, u) => flink(t, u))
  .replace(/(^|[\s（(「、：:])(https?:\/\/[^\s<）)」、。]+)/g, (_, h, u) => h + flink(u, u));   // bare URLs in the text (inside code / a the preceding char is > or ", so they are not picked)
// Mermaid (2026-10-12 "render Mermaid too"): ```mermaid (and blocks with no language that start with graph, flowchart…) become diagrams.
//   mermaid.js loads only when there is a diagram (this app's static/mermaid.min.js, else the CDN). If it can't load or render, the code stays. Same rendering as v2's app.js
const MERMAID_HEAD = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|timeline|journey)\b/;
let mermaidP = null, mermaidN = 0;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidP) {
    const one = (src) => new Promise((ok, ng) => { const s = el("script", { src }); s.onload = ok; s.onerror = ng; document.head.append(s); });
    // the copy in this extension's folder comes through aether.read (the frame has no origin to load it from); else the CDN
    const own = () => aether.read("mermaid.min.js").then((code) => { document.head.append(el("script", {}, code)); if (!window.mermaid) throw new Error("mermaid"); });
    mermaidP = own().catch(() => one("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"))
      .then(() => { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false } }); return window.mermaid; });
    mermaidP.catch(() => { mermaidP = null; });   // if it failed to load, try again on the next diagram
  }
  return mermaidP;
}
function mermaidFig(src, l0) {   // l0 = the source line number of the diagram's first line (after ```)
  const box = el("figure", { class: "mfig" }, el("pre", {}, src));
  const id = `fmmd${++mermaidN}`;
  loadMermaid().then((m) => m.render(id, src)).then(({ svg }) => {
    // Insert without innerHTML. Parse as HTML (mermaid 11 mixes <br> into labels, so parsing as SVG (XML) broke and no diagram showed — measured 2026-10-12)
    const fig = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
    if (!fig) throw new Error("svg");
    // Width: small diagrams keep their size; wide ones shrink to the frame but not below 70% (wider than that scrolls sideways in the frame — shrinking more makes text unreadable)
    const vw = parseFloat((fig.getAttribute("viewBox") || "").split(/[\s,]+/)[2]);
    if (vw > 0) { fig.style.removeProperty("max-width"); fig.style.width = `min(${Math.ceil(vw)}px, max(100%, ${Math.ceil(vw * 0.7)}px))`; }
    box.replaceChildren(document.importNode(fig, true));
    tagElems(box.querySelector("svg"), src, l0, id);
  }).catch(() => {});   // leave it as code
  return box;
}
// HTML screens (taken from SoloGen v3 on 2026-10-18): ```html ui renders its HTML in place as a screen figure (other viewers still read it as plain HTML code).
//   Sanitised before opening — script, iframe and similar elements, on* attributes, javascript: links, outside images (http src), CSS url( and @import are removed.
//   <style> is scoped to this figure by prefixing its selectors with the figure's mark. Each element's line (data-wl) is written in before parsing, and it gets .mel like Mermaid so the Element unit can quote it
let htmlN = 0;
const HTML_BAD = "script, iframe, frame, object, embed, link, meta, base, form, noscript, template";
function htmlFig(src, l0) {   // l0 = the source line number of the figure's first line (after ```)
  const n = ++htmlN, box = el("figure", { class: "mfig hfig", "data-h": String(n) });
  const tagged = src.split("\n").map((l, k) => l.replace(/<([a-zA-Z][\w-]*)(?=[\s/>])/g, `<$1 data-wl="${k}"`)).join("\n");
  const doc = new DOMParser().parseFromString(`<body>${tagged}</body>`, "text/html");
  doc.body.querySelectorAll(HTML_BAD).forEach((e) => e.remove());
  doc.body.querySelectorAll("*").forEach((e) => {
    for (const a of [...e.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith("on") || (/^(href|src|srcset|action|formaction|xlink:href)$/.test(a.name) && /^(javascript:|data:text|https?:|\/\/)/.test(v))) e.removeAttribute(a.name);
      else if (a.name === "style" && /url\(|expression\(/i.test(a.value)) e.removeAttribute("style");
    }
  });
  doc.body.querySelectorAll("style").forEach((st) => {   // this figure only: prefix each selector with .hfig[data-h=n] (nested rules like @media are dropped)
    const css = st.textContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;/gi, "").replace(/url\([^)]*\)/gi, "none");
    st.textContent = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, sel, body]) => `${sel.split(",").map((x) => `.hfig[data-h="${n}"] ${x.trim().replace(/^(html|body|:root)\b/, "")}`).join(", ")} {${body}}`).join("\n");
  });
  box.append(...[...doc.body.childNodes].map((x) => document.importNode(x, true)));
  const S = src.split("\n");
  box.querySelectorAll("[data-wl]").forEach((e) => {
    const k = +e.dataset.wl;
    if (e.tagName === "STYLE") return;
    e.classList.add("mel");
    e.mel = { kind: e.tagName.toLowerCase() + (e.classList[0] && e.classList[0] !== "mel" ? `.${e.classList[0]}` : ""), name: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) || (S[k] || "").trim().slice(0, 40), lines: [l0 + k] };
    e.setAttribute("data-l", String(l0 + k));
  });
  return box;
}
// Elements (2026-10-15 "add an Element unit to the MD preview so Mermaid elements can be quoted"): in a diagram,
//   nodes, groups (subgraph), links (lines and their labels), participants, messages, notes and tasks (gantt) get .mel and their source lines (mel.lines).
//   Source lines come from the id mermaid gave (flowchart-A-0, L_A_B_0, classId-…, state-…, entity-…, node_k, edgeN) or from searching the md for the text. If not found, the whole diagram's lines
const WORD = (s) => new RegExp(`(?<![\\p{L}\\p{N}_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
function tagElems(svg, src, l0, id) {
  if (!svg) return;
  const S = src.split("\n"), all = S.map((_, k) => k);
  const has = (...ws) => all.filter((k) => ws.every((w) => WORD(w).test(S[k])));
  const txt = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
  const byText = (t) => (t ? all.filter((k) => k && S[k].includes(t)) : []);
  const own = (e) => (e.id || "").replace(`${id}-`, "");
  const nodeName = (e) => { const m = own(e).match(/^(?:flowchart|classId|state|entity)-(.+)-\d+$/); return m ? m[1].replace(/^root_(start|end)$/, "[*]") : ""; };
  const names = new Set([...svg.querySelectorAll("g.node")].map(nodeName).filter(Boolean));
  const ends = (mid) => { const p = mid.split("_"); for (let k = 1; k < p.length; k++) { const a = p.slice(0, k).join("_"), b = p.slice(k).join("_"); if (names.has(a) && names.has(b)) return [a, b]; } return null; };
  const mind = all.filter((k) => k && S[k].trim() && !S[k].trim().startsWith("::"));   // mindmap: each line after the header is one node (node_k is the k-th)
  const arrows = all.filter((k) => S[k].includes("-->"));   // stateDiagram: edgeN is the line of the N-th arrow
  const mark = (e, kind, name, ks) => {
    e.classList.add("mel");
    e.mel = { kind, name: name || "(no name)", lines: (ks.length ? ks : all.slice(1)).map((k) => l0 + k) };
    e.setAttribute("data-l", String(e.mel.lines[0]));
    return e;
  };
  svg.querySelectorAll("g.node").forEach((e) => {
    const n = nodeName(e), m = own(e).match(/^node_(\d+)$/);
    mark(e, "node", txt(e) || n, n ? has(n) : m && mind[+m[1]] != null ? [mind[+m[1]]] : byText(txt(e)));
  });
  svg.querySelectorAll("g.cluster").forEach((e) => {   // from the subgraph line to its matching end
    const n = own(e), a = all.find((k) => new RegExp(`^\\s*subgraph\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(S[k]));
    let z = a, d = 0;
    if (a != null) for (z = a; z < S.length; z++) { if (/^\s*subgraph\b/.test(S[z])) d++; else if (/^\s*end\s*$/.test(S[z]) && !--d) break; }
    mark(e, "group", txt(e) || n, a == null ? has(n) : all.slice(a, Math.min(z, S.length - 1) + 1));
  });
  svg.querySelectorAll("path[data-id]").forEach((e) => {   // links: lines are thin and hard to click, so a transparent thick copy (.mhit) on top is the hit target. The label (edgeLabel) is the same link
    const d = e.dataset.id, lab = svg.querySelector(`.label[data-id="${CSS.escape(d)}"]`), t = lab ? txt(lab) : "";
    let m, ks = [];
    if ((m = d.match(/^id_entity-(.+?)-\d+_entity-(.+?)-\d+_\d+$/))) ks = has(m[1], m[2]);
    else if ((m = d.match(/^(?:L|id)_(.+)_(\d+)$/)) && ends(m[1])) { const [a, b] = ends(m[1]), xs = has(a, b); ks = xs[+m[2]] != null ? [xs[+m[2]]] : xs.slice(0, 1); }
    else if ((m = d.match(/^edge(\d+)$/)) && arrows[+m[1]] != null) ks = [arrows[+m[1]]];
    else if ((m = d.match(/^edge_\d+_(\d+)$/)) && mind[+m[1]] != null) ks = [mind[+m[1]]];
    if (!ks.length) ks = byText(t);
    const ab = m && ends(m[1] || ""), name = t || (ab ? `${ab[0]} → ${ab[1]}` : d);
    const hit = e.cloneNode(false);
    hit.removeAttribute("id"); hit.removeAttribute("marker-end"); hit.removeAttribute("marker-start"); hit.removeAttribute("style");
    hit.setAttribute("class", "mhit");
    e.after(hit);
    [e, hit, lab?.closest(".edgeLabel")].filter(Boolean).forEach((x) => mark(x, "link", name, ks).ref = e);
  });
  svg.querySelectorAll("g[id^='root-'][data-id]").forEach((e) => {   // participants: the participant/actor line (else the first line it appears on)
    const n = e.dataset.id, xs = has(n), def = xs.filter((k) => /^\s*(participant|actor)\b/.test(S[k]));
    mark(e, "participant", txt(e) || n, (def.length ? def : xs).slice(0, 1));
  });
  svg.querySelectorAll("text.messageText").forEach((e) => mark(e, "message", txt(e), byText(txt(e)).slice(0, 1)));
  svg.querySelectorAll("g[data-id]:has(> rect.note)").forEach((e) => mark(e, "note", txt(e), byText(txt(e)).slice(0, 1)));
  svg.querySelectorAll("rect.task[id]").forEach((e) => {
    const t = svg.querySelector(`[id="${CSS.escape(e.id)}-text"]`), n = t ? txt(t) : own(e);
    [e, t].filter(Boolean).forEach((x) => mark(x, "task", n, byText(n).slice(0, 1)).ref = e);
  });
}
// Sentences (2026-10-12 "let me quote MD by sentence, table cell, row and column"): a line is split at sentence-ending marks (Japanese full stop, full-width and ASCII ! ?) and at "a space after .",
//   one sentence = span.sn (data-l = source line number, raw = the source md text). many=false keeps the whole line as one (headings)
function sentences(raw) {   // not split inside brackets (Japanese corner brackets, full-width and ASCII parentheses), ** or ` (a quoted sentence followed by "he said." stays one sentence)
  const out = [], OPEN = "「『（(", CLOSE = "」』）)";
  let cur = "", depth = 0, bold = false, code = false;
  for (let k = 0; k < raw.length; k++) {
    const ch = raw[k];
    if (raw.startsWith("**", k) && !code) { bold = !bold; cur += "**"; k++; continue; }
    if (ch === "`") code = !code;
    else if (!code && OPEN.includes(ch)) depth++;
    else if (!code && CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    cur += ch;
    if (depth || bold || code) continue;
    const nx = raw[k + 1] || "";
    if ("。！？!?".includes(ch) && !"。！？!?」』）)”\"".includes(nx) && !(ch === "!" && nx === "[")) { out.push(cur); cur = ""; }   // ![ starts an image (not a sentence end)
    else if (ch === "." && /\s/.test(nx) && /[A-Z(「"]/.test(raw.slice(k + 1).trimStart()[0] || "")) { out.push(cur); cur = ""; }
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function sn(raw, l, many = false) {
  const span = (x) => { const e = el("span", { class: "sn", "data-l": String(l) }); e.innerHTML = inline(x); e.raw = x; return e; };
  if (!many) return span(raw.trim());
  const xs = sentences(raw);
  return xs.flatMap((x, k) => [...(k ? [" "] : []), span(x)]);
}
function blocks(text, kind) {
  const L = text.split("\n"), out = [];
  const add = (a, b, node) => { const d = el("div", { class: "blk", "data-a": String(a + 1), "data-b": String(b + 1), "data-k": node.tagName.toLowerCase() }); d.append(node); out.push(d); };
  if (kind === "text") { L.forEach((l, i) => { const n = el("span", { class: "ln" }, String(i + 1)); const c = el("code", {}, l || " "); add(i, i, el("span", {}, n, c)); }); return out; }
  const starts = (l) => /^(#{1,6}\s|```|\||>|\s*([-*+]|\d+\.)\s)/.test(l);
  for (let i = 0; i < L.length;) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let j = i, node;
    if (l.startsWith("```")) {
      while (++j < L.length && !L[j].startsWith("```"));
      const code = L.slice(i + 1, j), lang = l.slice(3).trim().toLowerCase();
      node = lang === "mermaid" || (!lang && MERMAID_HEAD.test(code[0] || "")) ? mermaidFig(code.join("\n"), i + 2)
        : lang === "html ui" ? htmlFig(code.join("\n"), i + 2) : el("pre", {}, code.join("\n"));
    } else if (/^#{1,6}\s/.test(l)) {
      node = el(`h${Math.min(l.match(/^#+/)[0].length + 1, 6)}`, {}, sn(l.replace(/^#+\s*/, ""), i + 1));   // a heading is one sentence
    } else if (l.startsWith("|")) {
      while (j + 1 < L.length && L[j + 1].startsWith("|")) j++;
      node = el("table", { class: "mdt" });
      L.slice(i, j + 1).forEach((r, k) => {   // rows keep the source line number (data-l); cells keep the column number (data-c) and source text (raw) — quoted by the Cell, Row and Column units
        if (/^\|[\s:|-]+\|?\s*$/.test(r)) return;
        const tr = el("tr", { "data-l": String(i + k + 1) }); tr.raw = r;
        r.replace(/^\||(?<!\\)\|\s*$/g, "").split(/(?<!\\)\|/).forEach((c, ci) => { c = c.replace(/\\\|/g, "|"); const td = el(node.childElementCount ? "td" : "th", { "data-c": String(ci + 1) }); td.innerHTML = inline(c.trim()); td.raw = c.trim(); tr.append(td); });
        node.append(tr);
      });
    } else if (/^\s*([-*+]|\d+\.)\s/.test(l) || l.startsWith(">")) {
      const q = l.startsWith(">");
      while (j + 1 < L.length && L[j + 1].trim() && (q ? L[j + 1].startsWith(">") : /^\s+\S|^\s*([-*+]|\d+\.)\s/.test(L[j + 1]))) j++;
      node = el(q ? "blockquote" : "ul");
      L.slice(i, j + 1).forEach((r, k) => node.append(el(q ? "div" : "li", { style: `margin-left:${(r.match(/^\s*/)[0].length / 2) * 1.2}em` }, ...sn(r.replace(/^\s*(>\s?|[-*+]\s|\d+\.\s)/, ""), i + k + 1, true))));
    } else {
      while (j + 1 < L.length && L[j + 1].trim() && !starts(L[j + 1])) j++;
      node = el("p", {}, ...L.slice(i, j + 1).flatMap((r, k) => [...(k ? [el("br")] : []), ...sn(r, i + k + 1, true)]));
    }
    add(i, Math.min(j, L.length - 1), node);
    i = j + 1;
  }
  return out;
}
const slug = (x) => x.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
function linkGo(e, a) {   // a link was clicked: outside opens a new tab, inside opens in the shell (the shell keeps ← →). Neither picks anything
  const u = a.getAttribute("href") || "";
  e.preventDefault();
  if (/^(https?|mailto):/i.test(u)) { aether.open(u); return; }   // the frame cannot open a tab itself (no allow-popups)
  if (u.startsWith("#")) {   // a heading in the same file: push the current position to the shell, then scroll there
    const want = slug(decodeURIComponent(u.slice(1))), h = [...document.querySelectorAll("#fbody .fdoc .blk")].find((x) => /^h\d$/.test(x.dataset.k) && slug(x.textContent) === want);
    if (h) { aether.scrolled($(".fmain").scrollTop); aether.open(SEL.f.path, u.slice(1)).catch(() => {}); h.scrollIntoView({ block: "start", behavior: "smooth" }); }
    return;
  }
  let p;
  try { p = decodeURI(u.split("#")[0]); } catch { p = u.split("#")[0]; }
  if (!p.startsWith("/")) {   // relative to this file's folder (.. too)
    const out = parent(SEL.f.path).split("/").filter(Boolean);
    for (const x of p.split("/")) { if (x === "..") out.pop(); else if (x && x !== ".") out.push(x); }
    p = out.join("/");
  }
  aether.scrolled($(".fmain").scrollTop);
  aether.open(p, u.includes("#") ? u.split("#").slice(1).join("#") : undefined).catch((err) => { a.classList.add("bad"); a.title = `Cannot open: ${u} (${err.message})`; });
}

// ―― picking: click, auto, parts, quotes ――
$("#fbody").addEventListener("click", (e) => {
  const a = e.target.closest("#fbody .fdoc a.flink");
  if (a) { linkGo(e, a); return; }
  const b = e.target.closest(".blk");
  if (!b || !SEL) return;
  const u = SEL.f.kind === "md" ? FV.unit : "blk";
  if (u === "auto" && !e.shiftKey) { autoShow(e.target, e.clientX, e.clientY); if (AUTO.cands.length) autoPick(0); return; }   // Auto: the smallest unit where clicked (Shift: a range of blocks)
  const part = PART[u] ? e.target.closest(PART[u]) : null;
  if (part) { pickPart(u, part, b); drawSel(); return; }
  const all = [...document.querySelectorAll("#fbody .blk")], i = all.indexOf(b);
  if (e.shiftKey && SEL.last != null) { const [a, z] = [Math.min(SEL.last, i), Math.max(SEL.last, i)]; all.slice(a, z + 1).forEach((x) => x.classList.add("sel")); }
  else b.classList.toggle("sel");
  SEL.last = i;
  if (e.shiftKey) getSelection().removeAllRanges();
  drawSel();
});

// Auto (2026-10-17 "add Auto: show the clip and the range at the mouse position and let me pick"): with the Auto unit,
//   where the mouse is, show 📎 chips (the matching units, smallest first — Element, Sentence, Cell, Row, Column, Block) and a dashed frame for the range. Hovering a chip shows its range,
//   clicking a chip picks in that unit. Clicking the text picks the smallest unit (a chip clicked right after re-picks — touch devices can't hover, so they click, then switch with a chip).
//   Moving elsewhere waits a little before moving the chips (so moving the mouse to the chips doesn't jump to sentences on the way). Hidden on scroll
//   The 📎 at the head of the chips adds everything picked to the quotes (= [📎 Add to quotes]; with nothing picked, the framed unit — 2026-10-17 "clicking the clip icon quotes the whole selection")
const BKIND = { h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading", p: "Paragraph", ul: "List", table: "Table", pre: "Code", figure: "Figure", blockquote: "Quote" };
const AUTO = { cands: [], tip: null, frame: null, t: 0, wait: null, xy: [0, 0], last: null, cur: null };
function cands(t) {   // units matching under the mouse (smallest first): { u, x (what pickPart gets), blk, els (what the range frame encloses), name }
  const b = t?.closest?.("#fbody .fdoc .blk");
  if (!b) return [];
  const out = [], m = t.closest(".mfig .mel"), s = t.closest(".sn"), c = t.closest("table.mdt td, table.mdt th");
  if (m) { const r = m.ref || m; out.push({ u: "elem", x: m, els: [...b.querySelectorAll(".mel:not(.mhit)")].filter((e) => (e.ref || e) === r), name: `Element (${r.mel?.kind || "figure"})` }); }
  if (s && !/^h\d$/.test(b.dataset.k)) out.push({ u: "sent", x: s, els: [s] });   // a heading is one sentence = the same range as the block, so not offered
  if (c) out.push({ u: "cell", x: c, els: [c] }, { u: "row", x: c, els: [c.closest("tr")] }, { u: "col", x: c, els: [...b.querySelectorAll(`[data-c="${c.dataset.c}"]`)] });
  out.push({ u: "blk", x: b, els: [b], name: BKIND[b.dataset.k] || "Block" });
  return out.map((o) => ({ ...o, blk: b, name: o.name || UNITS[o.u] }));
}
const autoOn = () => SEL?.f.kind === "md" && FV.unit === "auto";
const sameC = (a, b) => a && b && a.u === b.u && a.els[0] === b.els[0];
function autoEls() {
  if (!AUTO.tip?.isConnected) {   // #fbody is replaced every time a file opens, so create them each time
    AUTO.frame = el("div", { class: "fautof", hidden: "" });
    AUTO.tip = el("div", { class: "fauto", role: "toolbar", "aria-label": "Quote unit (Auto)", hidden: "" });
    $("#fbody").append(AUTO.frame, AUTO.tip);
  }
}
function autoFrame(c) {   // range: a dashed frame around the rects of what it encloses (a column: all its cells; a line: its label too)
  const rs = c.els.map((e) => e.getBoundingClientRect()).filter((r) => r.width || r.height);
  if (!rs.length) { AUTO.frame.hidden = true; return; }
  const P = $(".fmain").getBoundingClientRect();   // clip outside the preview frame (long columns etc.) — it is fixed, so it would otherwise reach over ③
  const l = Math.max(P.left, Math.min(...rs.map((r) => r.left))), t = Math.max(P.top, Math.min(...rs.map((r) => r.top))), r = Math.min(P.right - 2, Math.max(...rs.map((r) => r.right))), b = Math.min(P.bottom - 2, Math.max(...rs.map((r) => r.bottom)));
  Object.assign(AUTO.frame.style, { left: `${l - 2}px`, top: `${t - 2}px`, width: `${r - l + 4}px`, height: `${b - t + 4}px` });
  AUTO.frame.dataset.n = c.name; AUTO.frame.hidden = false;
  AUTO.cur = c;
  AUTO.tip.querySelectorAll("button[data-u]").forEach((x, i) => x.classList.toggle("cur", AUTO.cands[i] === c));
  autoClip();
}
const isPicked = (c) => c.u === "blk" ? c.blk.classList.contains("sel") : SEL.items.some((it) => it.t === c.u && it.key === partKey(c.u, c.x, c.blk).key);
function autoMark() { if (AUTO.tip?.isConnected && !AUTO.tip.hidden) { AUTO.tip.querySelectorAll("button[data-u]").forEach((x, i) => { const on = !!AUTO.cands[i] && isPicked(AUTO.cands[i]); x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); }); autoClip(); } }
function autoClip() {   // the 📎 tooltip: "add the n picked" if something is picked, else the framed unit
  const k = AUTO.tip?.querySelector("button.clip"), n = SEL ? picked().length : 0;
  if (k) { k.title = n ? `Add the ${n} picked to quotes` : `Add ${AUTO.cur?.name || ""} to quotes`; k.classList.toggle("has", !!n); }
}
function autoQuote() {   // 📎 clicked: quote everything picked (with nothing picked, pick the framed unit and quote it)
  if (!SEL) return;
  if (!picked().length && (AUTO.cur || AUTO.cands[0])) pickC(AUTO.cur || AUTO.cands[0]);
  if (picked().length) quotePicked();
  AUTO.last = null;
}
function autoShow(t, x, y) {
  const cs = cands(t);
  if (!cs.length) { autoHide(); return; }
  autoEls();
  if (!AUTO.tip.hidden && sameC(cs[0], AUTO.cands[0])) return;   // just moving over the same spot
  AUTO.cands = cs; AUTO.last = null;
  AUTO.tip.replaceChildren(btn(mui("AttachFile"), (ev) => { ev.stopPropagation(); autoQuote(); }, { class: "clip", "aria-label": "Add to quotes" }), ...cs.map((c, i) => {
    const b = btn(c.name, (ev) => { ev.stopPropagation(); autoPick(i, true); }, { "data-u": c.u, title: `Pick ${c.name} (click again to unpick)` });
    b.addEventListener("mouseenter", () => autoFrame(c));
    return b;
  }));
  AUTO.tip.hidden = false;
  const P = $(".fmain").getBoundingClientRect(), w = AUTO.tip.offsetWidth, h = AUTO.tip.offsetHeight;
  let top = y - h - 8;
  if (top < P.top + 2) top = y + 18;   // no room above: below the mouse
  Object.assign(AUTO.tip.style, { left: `${Math.max(P.left + 4, Math.min(x + 10, P.right - w - 4))}px`, top: `${top}px` });
  autoFrame(cs[0]); autoMark();
  AUTO.top = cs[0].els[0].getBoundingClientRect().top;
}
function autoHide() {
  clearTimeout(AUTO.t); AUTO.wait = null; AUTO.cands = []; AUTO.last = null; AUTO.cur = null;
  if (AUTO.tip) AUTO.tip.hidden = true;
  if (AUTO.frame) AUTO.frame.hidden = true;
}
function autoPick(i, chip = false) {
  const c = AUTO.cands[i], prev = AUTO.last != null ? AUTO.cands[AUTO.last] : null;
  if (!c || !SEL) return;
  if (chip && prev && prev !== c && isPicked(prev)) pickC(prev);   // another chip right after a click-pick = re-pick
  pickC(c);
  AUTO.last = i;
  autoFrame(c); drawSel();
}
function pickC(c) {
  if (c.u !== "blk") { pickPart(c.u, c.x, c.blk); return; }
  c.blk.classList.toggle("sel");
  SEL.last = [...document.querySelectorAll("#fbody .blk")].indexOf(c.blk);
}
$("#fbody").addEventListener("mousemove", (e) => {
  if (!autoOn()) return;
  AUTO.xy = [e.clientX, e.clientY];
  if (e.target.closest(".fauto")) { clearTimeout(AUTO.t); AUTO.wait = null; return; }
  const c = cands(e.target)[0] || null;
  if (AUTO.tip?.isConnected && !AUTO.tip.hidden && sameC(c, AUTO.cands[0])) { clearTimeout(AUTO.t); AUTO.wait = null; return; }
  if (!AUTO.tip?.isConnected || AUTO.tip.hidden) { autoShow(e.target, e.clientX, e.clientY); return; }   // not shown yet: show at once
  if (sameC(c, AUTO.wait) || (!c && AUTO.wait === "none")) return;   // already waiting for the same target
  clearTimeout(AUTO.t); AUTO.wait = c || "none";
  const t = e.target;
  AUTO.t = setTimeout(() => { AUTO.wait = null; autoShow(t, ...AUTO.xy); }, 280);
});
$("#fbody").addEventListener("mouseleave", () => { if (autoOn()) { clearTimeout(AUTO.t); AUTO.wait = "none"; AUTO.t = setTimeout(autoHide, 280); } });
$("#fbody").parentElement.addEventListener("scroll", () => {   // hide when the content moves (kept when the browser scrolls to hold position as the bar above grows after picking — the content doesn't move then)
  if (AUTO.tip && !AUTO.tip.hidden && Math.abs((AUTO.cands[0]?.els[0].getBoundingClientRect().top ?? NaN) - AUTO.top) > 1) autoHide();
}, { passive: true });

function partKey(u, x, blk) {   // a column's key is its number within the same table; for elements, a line and its label (a task's bar and text) are one
  const node = u === "row" ? x.closest("tr") : u === "elem" ? x.ref || x : x, c = +x.dataset.c || 0;
  return { node, c, key: u === "col" ? `${blk.dataset.a}:${c}` : node };
}
function pickPart(u, x, blk) {   // pick a sentence, cell, row, column or element (click again to unpick)
  const { node, c, key } = partKey(u, x, blk);
  const has = SEL.items.findIndex((it) => it.t === u && it.key === key);
  if (has >= 0) SEL.items.splice(has, 1); else SEL.items.push({ t: u, key, blk, node, c });
  (u === "col" ? [...blk.querySelectorAll(`[data-c="${c}"]`)] : u === "elem" ? [...blk.querySelectorAll(".mel")].filter((m) => (m.ref || m) === node) : [node])
    .forEach((m) => m.classList.toggle(u === "col" ? "csel" : "sel", has < 0));
}
function picked() {   // what is picked now (consecutive blocks are merged)
  if (!SEL) return [];
  const runs = [];
  document.querySelectorAll("#fbody .blk.sel").forEach((b) => {
    const a = +b.dataset.a, z = +b.dataset.b, last = runs[runs.length - 1];
    if (last && last.next === b.previousElementSibling) { last.b = z; last.next = b; last.kinds.push(b.dataset.k); } else runs.push({ t: "lines", a, b: z, next: b, kinds: [b.dataset.k] });
  });
  return [...runs, ...SEL.items];
}
function drawSel() {
  autoMark();
  drawBar();   // 📎 Add n to quotes · Clear sit in the shell's bar
}
function clearSel() {
  document.querySelectorAll("#fbody .sel, #fbody .csel").forEach((x) => x.classList.remove("sel", "csel"));
  document.querySelectorAll("#fbody .rect").forEach((x) => x.remove());
  if (SEL) { SEL.items = []; SEL.last = null; }
  drawSel();
}
const cut = (x, n = 30) => (x.length > n ? `${x.slice(0, n)}…` : x);
function partQuote(f, p) {
  const head = `${ICON[f.kind]} ${f.abs}`;
  if (p.t === "sent") { const l = p.node.dataset.l; return { label: `${f.name} sentence, line ${l} "${cut(p.node.raw, 20)}"`, text: `${head} line ${l}, sentence:\n  > ${p.node.raw}` }; }
  if (p.t === "elem") {   // a diagram element: the source lines where it appears (with line numbers). The range is first–last line
    const m = p.node.mel, L = (f.text || "").split("\n"), a = Math.min(...m.lines), z = Math.max(...m.lines);
    let body = "";
    for (const l of m.lines) { const x = `  > line ${l}: ${L[l - 1].trim()}\n`; if (body.length + x.length > QUOTE_MAX) { body += "  > … (cut for length — read those lines in the file)\n"; break; } body += x; }
    const fig = p.blk.querySelector(".hfig") ? "HTML screen figure" : "Mermaid diagram";
    return { label: `${f.name} figure, line ${a}, ${m.kind} "${cut(m.name, 12)}"`, text: `${head} ${a === z ? `line ${a}` : `lines ${a}–${z}`} (${m.kind} "${m.name}" in the ${fig} at lines ${p.blk.dataset.a}–${p.blk.dataset.b}; below are the source lines where it appears):\n${body.trimEnd()}` };
  }
  const tbl = p.blk.querySelector("table"), trs = [...tbl.querySelectorAll("tr")], hdr = trs[0];
  const name = (c) => hdr.querySelector(`[data-c="${c}"]`)?.raw || `column ${c}`;
  if (p.t === "cell") {
    const tr = p.node.closest("tr"), l = tr.dataset.l, first = tr.querySelector("[data-c='1']")?.raw || "";
    return { label: `${f.name} table, line ${l}, ${cut(name(p.c), 12)}`, text: `${head} line ${l}, table cell (column ${p.c} "${name(p.c)}"${tr === hdr ? ", header row" : `, row head "${first}"`}):\n  > ${p.node.raw}` };
  }
  if (p.t === "row") {
    const l = p.node.dataset.l;
    return { label: `${f.name} table, line ${l}`, text: `${head} line ${l} (table row${p.node === hdr ? ", header row" : `; the line above is the header (line ${hdr.dataset.l})`}):\n${p.node === hdr ? "" : `  > ${hdr.raw}\n`}  > ${p.node.raw}` };
  }
  let body = "", n = 0;
  const rows = trs.slice(1);
  for (const tr of rows) {
    const x = `  > line ${tr.dataset.l} "${tr.querySelector("[data-c='1']")?.raw || ""}": ${tr.querySelector(`[data-c="${p.c}"]`)?.raw ?? ""}\n`;
    if (body.length + x.length > QUOTE_MAX) break;
    body += x; n++;
  }
  const more = n < rows.length ? `\n  > … (from line ${rows[n].dataset.l} on, cut for length — read those lines in the file)` : "";
  return { label: `${f.name} table column "${cut(name(p.c), 12)}"`, text: `${head} lines ${p.blk.dataset.a}–${p.blk.dataset.b}, table column "${name(p.c)}" (column ${p.c}; per row "row head": value):\n${body.trimEnd()}${more}` };
}
function quotePicked() {
  const f = SEL.f, L = (f.text || "").split("\n");
  addQuotes(picked().map((p) => {
    if (p.t === "lines") {
      // a picked block is quoted whole (a table with all its rows). Only when too long, cut at a line break and say which lines were left out
      const lines = L.slice(p.a - 1, p.b), table = p.kinds.every((k) => k === "table"), fig = p.kinds.every((k) => k === "figure");
      let body = "", n = 0;
      for (const l of lines) { if (body.length + l.length > QUOTE_MAX) break; body += `  > ${l}\n`; n++; }
      const cut = n < lines.length ? `\n  > … (lines ${p.a + n}–${p.b} cut for length — read those lines in the file)` : "";
      return { label: `${f.name} ${table ? "table " : fig ? "figure " : ""}${p.a === p.b ? `line ${p.a}` : `lines ${p.a}–${p.b}`}`, text: `${ICON[f.kind]} ${f.abs} lines ${p.a}–${p.b}${table ? " (whole table)" : fig ? " (whole figure; below is the source)" : ""}:\n${body.trimEnd()}${cut}` };
    }
    return partQuote(f, p);
  }));
  clearSel();
}

// ―― ⬇ ▾ 🖨 print · ▶ present · 🖨 PDF ――
async function printView(f) {
  const body = $("#fbody");
  let kids;
  if (f.kind === "md" || f.kind === "text") {
    const d = body.querySelector(".fdoc")?.cloneNode(true);
    if (!d) return;
    d.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel"));
    // move a table's header row into thead — tables that cross pages show the header on every page (the copy only; the preview's table is unchanged)
    d.querySelectorAll("table.mdt").forEach((t) => { const rs = [...t.children].filter((r) => r.tagName === "TR"); if (rs.length) t.replaceChildren(el("thead", {}, rs[0]), el("tbody", {}, ...rs.slice(1))); });
    kids = [d];
  } else kids = [...body.querySelectorAll(".pg img")].map((i) => el("div", { class: "ppg" }, el("img", { src: i.src, alt: i.alt })));
  if (!kids.length) return;
  return printKids(f.name, `
    body { margin: 0; padding: 0 4mm; background: #fff; color: #1d2433; font: 14px/1.7 -apple-system, "Hiragino Sans", sans-serif; }
    h1.ptitle { font-size: 12px; color: #667; font-weight: 400; margin: 0 0 8px; }
    .fdoc .blk { cursor: auto; border-left-color: transparent !important; background: none !important; break-inside: avoid; }
    .fdoc .mfig { overflow: visible; } .fdoc .mfig svg { max-width: 100% !important; width: auto !important; }
    .fdoc .mhit { display: none; } .fdoc .mel { outline: none !important; }
    .fdoc .blk:has(table) { break-inside: auto; }
    .fdoc table.mdt { width: 100%; max-width: 100%; font-size: 10.5px; line-height: 1.5; }
    .fdoc table.mdt :is(th, td) { padding: 3px 5px; overflow-wrap: break-word; vertical-align: top; }
    .fdoc table.mdt thead { display: table-header-group; } .fdoc table.mdt th { background: #f1f3f8 !important; }
    .fdoc table.mdt tr { break-inside: avoid; }
    .fdoc .blk:has(> :is(h2, h3, h4, h5, h6)) { break-after: avoid; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .ppg { break-after: page; } .ppg:last-child { break-after: auto; } .ppg img { display: block; width: 100%; height: auto; }
    @page { margin: 12mm; }
`, kids, `<h1 class="ptitle">${esc(f.abs || f.path)}</h1>`);
}
async function printKids(title, style, kids, head = "") {   // put the copies (kids) on this page and print it (only the copies show while printing). style = CSS for those copies only
  // SoloGen v3 prints from a hidden iframe copy, but here we are inside a sandbox (opaque origin) and cannot touch a child iframe's document — so we print ourselves
  document.querySelectorAll(".fprint-root, .fprint-css").forEach((x) => x.remove());
  const root = el("div", { class: "fprint-root" });
  root.innerHTML = head;
  root.append(...kids);
  const css = el("style", { class: "fprint-css" }, `@media screen { .fprint-root { display: none !important; } }
@media print { html, body { height: auto !important; display: block !important; overflow: visible !important; } body > :not(.fprint-root) { display: none !important; } ${style} }`);
  document.head.append(css); document.body.append(root);
  await Promise.all([...root.querySelectorAll("img")].map((i) => i.complete || new Promise((ok) => { i.onload = i.onerror = ok; })));
  await new Promise((ok) => setTimeout(ok, 50));
  const was = document.title;
  document.title = title;   // the default name for "Save as PDF"
  window.addEventListener("afterprint", () => { root.remove(); css.remove(); document.title = was; }, { once: true });
  window.print();
}
// 🖨 Presentation to PDF (2026-10-17 "let me choose play or PDF for each look"):
//   prints the same slides as play (md: a landscape 1280×720 sheet; paged files: one page image), one per page — destination: Save as PDF.
//   @page matches the sheet size (md: 1280×720 px = 13.33×7.5 in = the same area as a 16:9 template)
async function presentPdf(f, tpl = TPL_MAIN) {   // md only (for paged files, PDF is the print in [⬇ Download | ▾])
  const src = [...$("#fbody").querySelectorAll(".fdoc > .blk")];
  if (!src.length) return;
  const host = el("div", { class: "phost" }), tmp = el("div", { class: "pdeck pmeasure", "aria-hidden": "true" }, host);   // a hidden place to measure while laying out
  document.body.append(tmp);
  let slides;
  try { slides = deckOf(src, f, host, 1280, 720, tpl); } finally { tmp.remove(); }
  return printKids(f.name, "* { -webkit-print-color-adjust: exact; print-color-adjust: exact; } body { margin: 0; } @page { size: 1280px 720px; margin: 0; } .pdeck.pprint { position: static; display: block; background: none; } .pdeck.pprint .pslide { position: relative; box-shadow: none; break-after: page; break-inside: avoid; } .pdeck.pprint .pslide:last-child { break-after: auto; }",
    [el("div", { class: "pdeck pprint" }, ...slides.map((x) => x.s))]);
}

const canPresent = (f) => !f.viewer && ["md", "image", "pages"].includes(f.kind);
const hlv = (b) => /^h\d$/.test(b.dataset.k) ? +b.dataset.k[1] - 1 : 0;   // the number of # in the md (blocks draws # as h2)
function deckOf(src, f, host, W, H, tpl = "simple") {   // → [{s (one slide), blks (source blocks)}]. tpl = the look (simple or a name under tpl/). Placed in host (hidden) and split while measuring overflow
  const hs = src.filter(hlv), first = hs[0];
  const cover = first && hs.filter((b) => hlv(b) <= hlv(first)).length === 1 ? first : null;   // only one top-level heading = the cover title
  const top = Math.min(...hs.filter((b) => b !== cover).map(hlv));
  const txt = (b) => b.textContent.trim();
  const secs = [], up = [];
  let cur = { h: null, blks: [], up: [] };
  secs.push(cur);
  for (const b of src) {
    if (b === cover) continue;
    if (!hlv(b)) { cur.blks.push(b); continue; }
    while (up.length && hlv(up.at(-1)) >= hlv(b)) up.pop();
    cur = { h: b, blks: [], up: [...up] };
    secs.push(cur); up.push(b);
  }
  const out = [];
  const sl = (cls, ...kids) => el("div", { class: `pslide ${cls} t-${tpl}`, style: `width:${W}px;height:${H}px` }, ...kids);
  const clean = (b) => {
    const c = b.cloneNode(true);
    c.querySelectorAll(".sel, .csel").forEach((x) => x.classList.remove("sel", "csel"));
    c.querySelectorAll(".rect, .bx, .pno, .mhit").forEach((x) => x.remove());
    // a Mermaid svg's width follows 100% of its parent — widening the area while shrinking grows the figure too, and the height never fits. Fix it in px to the sheet width
    c.querySelectorAll(".mfig svg[viewBox]").forEach((x) => { const vw = +x.getAttribute("viewBox").split(/\s+/)[2]; if (vw) x.style.width = `${Math.min(vw, W - 120)}px`; });
    c.classList.remove("sel");
    return c;
  };
  const over = (a) => a.scrollHeight > a.clientHeight + 1;
  const shrink = (a) => {   // a slide that doesn't fit: shrink the content to fit (widen by the shrink factor and re-lay out; the scale is found by bisection)
    const fit = a.firstChild;
    if (!fit) return;
    fit.style.width = ""; fit.style.transform = "";
    if (!over(a) && fit.scrollWidth <= a.clientWidth + 1) return;
    const ok = (s) => { fit.style.width = `${100 / s}%`; return fit.scrollHeight * s <= a.clientHeight + 1 && fit.scrollWidth * s <= a.clientWidth + 1; };
    let lo = Math.min(1, a.clientHeight / fit.scrollHeight, a.clientWidth / fit.scrollWidth), hi = 1;
    for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    ok(lo); fit.style.transform = `scale(${lo})`;
  };
  // How to split (2026-10-17 "split presentations as little as possible (fit on one slide where possible); above all, never split figures or tables"):
  //   First shrink to fit one slide. Split only when text would fall below MIN scale (or 0.85× that of a table/figure that doesn't fit even alone), and then use the fewest slides (the count packed at MIN), evening out the scale across pages.
  //   Tables, figures, images and code are not split (if they don't fit, the whole slide shrinks). Splits happen only between blocks and between list items
  const MIN = 0.62;
  const pack = (mk, units, s, last) => {   // mk() → {s, a (parent of the content area .pfit)}; units = [{blk, c (copy)} | {blk, parts (items), wrap}]; packs by whether it fits at scale s
    const pages = [];
    let pg = null, n = 0;
    const end = () => { if (pg) { if (last) shrink(pg.a); pg.s.remove(); } };
    const page = () => { end(); pg = mk(); pg.blks = new Set(); host.append(pg.s); pg.a.firstChild.style.width = `${100 / s}%`; pages.push(pg); n = 0; };
    const full = () => pg.a.firstChild.scrollHeight * s > pg.a.clientHeight + 1;
    page();
    const fitIn = () => pg.a.firstChild;
    for (const u of units) {
      if (!u.parts) {
        fitIn().append(u.c); pg.blks.add(u.blk);
        if (full() && n) { u.c.remove(); page(); fitIn().append(u.c); pg.blks.add(u.blk); }
        n++; continue;
      }
      let w = null, box = null;
      const open = () => { [w, box] = u.wrap(); fitIn().append(w); pg.blks.add(u.blk); };
      open();
      if (full() && n) { w.remove(); page(); open(); }
      let m = 0;
      for (const r of u.parts) {
        box.append(r);
        if (full() && (m || n)) { r.remove(); if (!m) w.remove(); page(); open(); box.append(r); m = 0; }
        m++; n++;
      }
    }
    end();
    return pages;
  };
  const alone = (mk, u) => {   // the scale of one unsplittable unit (table, figure…) alone on a slide
    const pg = mk(); host.append(pg.s); pg.a.firstChild.append(u.c); shrink(pg.a);
    const r = +(pg.a.firstChild.style.transform.match(/[\d.]+/) || [1])[0];
    pg.s.remove(); return r;
  };
  // Only large tables split by rows (2026-10-17 "this table is really too small to read; split it over 2 pages and work out a threshold for splitting"):
  //   Two thresholds — split only tables that can't reach TBL scale even alone on a slide (table text 15px → 7.5px, about 5.6pt on a 13.33in sheet).
  //   When splitting, use the fewest k slides (2–4; 4 if none reach it) where each reaches MIN like other text (9.3px, about 7pt). The gap keeps "don't split figures and tables" intact
  //   (in one real document a 26-row table is 0.41× alone → 0.65/0.65× on 2 slides; other tables are 0.86× or more and are not split).
  //   Split points are evened out by row height; each slide gets the header row, and a ditto mark (〃) in the first row is replaced by the value above
  const TBL = 0.5;
  const tblSplit = (mk, u) => {
    const t = u.c.querySelector(":scope > table.mdt");
    if (!t || t.rows.length < 5) return [u];
    if (alone(mk, u) >= TBL) return [u];
    const pg = mk(); host.append(pg.s); pg.a.firstChild.append(u.c);
    const rows = [...t.rows], body = rows.slice(1), hs = body.map((r) => r.offsetHeight);
    pg.s.remove(); u.c.remove();
    const all = hs.reduce((a, b) => a + b, 0);
    const piece = (a, b) => {   // one slide's table: body[a, b) plus the header row
      const c = u.c.cloneNode(false), x = t.cloneNode(false);
      x.append(rows[0].cloneNode(true), ...body.slice(a, b).map((r) => r.cloneNode(true)));
      [...x.rows[1].cells].forEach((td, ci) => {
        if (td.textContent.trim() !== "〃") return;
        for (let j = a - 1; j >= 0; j--) { const v = body[j].cells[ci]; if (v && v.textContent.trim() !== "〃") { td.innerHTML = v.innerHTML; break; } }
      });
      c.append(x); return { blk: u.blk, c };
    };
    let best = [u];
    for (let k = 2; k <= Math.min(4, body.length); k++) {
      const cuts = [0];
      for (let i = 1, acc = 0, j = 0; i < k; i++) { while (j < body.length - (k - i) && acc + hs[j] / 2 < all * i / k) acc += hs[j++]; cuts.push(Math.max(j, cuts.at(-1) + 1)); }
      cuts.push(body.length);
      best = cuts.slice(1).map((b, i) => piece(cuts[i], b));
      if (Math.min(...best.map((p) => alone(mk, p))) >= MIN) break;
    }
    return best;
  };
  const packFew = (mk, units) => {   // with the fewest slides, find by bisection the scale that makes text largest at that count
    units = units.flatMap((u) => (u.c ? tblSplit(mk, u) : [u]));
    // if a table/figure doesn't fit at MIN even alone, moving what's around it to another slide won't make text bigger — keep it on the same slide down to 0.85× its scale
    const min = Math.min(MIN, 0.85 * Math.min(1, ...units.filter((u) => !u.parts).map((u) => alone(mk, u))));
    const k = pack(mk, units, min).length;
    let lo = min, hi = 1;
    if (k > 1) {
      if (pack(mk, units, 1).length <= k) lo = 1;
      else for (let j = 0; j < 6; j++) { const m = (lo + hi) / 2; if (pack(mk, units, m).length <= k) lo = m; else hi = m; }
    }
    return pack(mk, units, lo, true);
  };
  const unitsOf = (blks) => blks.map((b) => {
    const c = clean(b), l = c.querySelector(":scope > :is(ul, blockquote)");
    if (l && !l.querySelector("table, img, svg, pre")) { const items = [...l.children]; return { blk: b, parts: items, wrap: () => { const w = c.cloneNode(false), x = l.cloneNode(false); w.append(x); return [w, x]; } }; }
    return { blk: b, c };   // tables, figures, images, code and paragraphs are not split
  });
  // Types (2026-10-24 "pick a close template when showing MD"): if the look's tpl.json has types (one type per slide of the template pptx; tpl/make_tpl.py --types),
  //   pick a close type for each section and lay it out in its form. First narrow to types the section's shape (table, list items, numbers, subheadings, figure) can fill,
  //   then decide by how often the type's name and words (keys) appear in the title, message, column names and items. Tables and figures get a type only when words match (shape alone doesn't say what the table is about).
  //   If none fit, as before (standard page). A section with 2–6 subheadings puts them on one slide as split / cards / steps
  const TYPES = (TPLS[tpl] || {}).types || [];
  const NUM = /\d[\d.,]*\s*[^\s\d→⇒]{0,4}\s*(?:→|⇒|->)\s*\d[\d.,]*[^\s、。（）()]{0,4}|\d[\d.,]*\s*(?:%|％|倍)/;
  const PH = /^\s*(phase|step|フェーズ|ステップ|段階|第\s*\d|fy\s?\d|\d{4}\s*年|\d{1,2}\s*月|\d{1,2}\/\d{1,2}|q[1-4]\b|[①-⑨])/i;
  const LBL = /^(.{1,18}?)\s*[：:]\s*(\S[\s\S]*)$/;
  const HL = /推奨|当社|自社|今回/;
  const entriesOfList = (ul) => {
    const out = [];
    for (const li of ul.children) { if (!(parseFloat(li.style.marginLeft) || 0) || !out.length) out.push({ li, subs: [] }); else out.at(-1).subs.push(li); }
    return out.map(({ li, subs }) => { const t = li.textContent.trim(), m = t.match(LBL); return { title: t, text: [t, ...subs.map(txt)].join(" "), label: m ? m[1] : "", lead: m ? m[2] : "", li, subs, kid: null }; });
  };
  const entriesOfKids = (ks) => ks.map((k) => ({ title: txt(k.h), text: [txt(k.h), ...k.blks.map(txt)].join(" "), label: txt(k.h), lead: "", li: null, subs: [], kid: k }));
  const FITS = {   // item layout → forms it can fill
    kpi: (E) => E.length >= 2 && E.length <= 4 && E.every((e) => NUM.test(e.text) && e.text.length <= 200),
    phases: (E) => E.length >= 2 && E.length <= 6 && E.every((e) => PH.test(e.title) && e.text.length <= 260),
    split: (E, kids) => E.length === 2 && E.every((e) => (kids || e.subs.length) && e.text.length <= 600),
    rows: (E) => E.length >= 2 && E.length <= 6 && E.every((e) => e.label && e.text.length <= 220),
    cards: (E, kids) => E.length >= 2 && E.length <= 4 && E.every((e) => (kids || e.subs.length) && e.text.length <= 320),
  };
  const ORDER = ["kpi", "phases", "split", "gantt", "rows", "cards", "photo", "wide", "table", "figure"];   // with equal word matches, the form with the stronger shape wins
  const SHAPED = new Set(["kpi", "phases", "split", "gantt", "rows", "cards", "photo"]);   // forms that may be chosen by shape alone, without word matches
  const gantt = (b) => b.dataset.k === "figure" ? !!b.querySelector('svg[aria-roledescription="gantt"]') || /^\s*gantt\b/.test(b.querySelector("pre")?.textContent || "")
    : [...(b.querySelector("tr")?.cells || [])].filter((c) => /^(\d{1,2}月|Q[1-4]|\d{1,2}\/\d{1,2})$/i.test(c.textContent.trim())).length >= 3;
  const better = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k]; return false; };
  const pick = (forms, hay) => {
    let best = null;
    for (const ty of TYPES) {
      if (!forms.has(ty.form)) continue;
      const s = (ty.keys || []).reduce((a, k) => a + hay.reduce((b, [t, w]) => b + (t.toLowerCase().includes(k.toLowerCase()) ? w : 0), 0), 0);
      if (!s && !SHAPED.has(ty.form)) continue;
      const r = [s, -ORDER.indexOf(ty.form), -ty.no];
      if (!best || better(r, best.r)) best = { ty, r };
    }
    return best?.ty || null;
  };
  const formBox = (form, E) => {   // items → card / step / split / KPI boxes (one unsplittable unit)
    const box = el("div", { class: `blk kf k-${form}`, style: `--n:${E.length}` });
    for (const e of E) {
      let head, body = [];
      if (e.kid) { head = [txt(e.kid.h)]; body = e.kid.blks.map(clean); }
      else {
        head = e.label ? [e.label] : [...e.li.cloneNode(true).childNodes];
        if (e.lead) body.push(el("p", {}, e.lead));
        if (e.subs.length) {
          const u = el("ul");
          e.subs.forEach((x) => { const c = x.cloneNode(true); c.style.marginLeft = `${Math.max(0, (parseFloat(x.style.marginLeft) || 0) - 1.2)}em`; u.append(c); });
          body.push(u);
        }
      }
      let big = null;
      if (form === "kpi") {
        const m = e.text.match(NUM);
        big = el("div", { class: "kbig" }, m[0].trim());
        if (!e.kid) {
          const t = e.label ? e.lead : e.title, at = t.indexOf(m[0]), rest = at < 0 ? t : `${t.slice(0, at)}${t.slice(at + m[0].length)}`.replace(/^[\s、。：:]+|[\s、。：:]+$/g, "");
          if (!e.label) head = [at > 0 ? t.slice(0, at).replace(/[\s、：:]+$/, "") : rest || t];
          body = [...(e.label && rest ? [el("p", {}, rest)] : !e.label && at > 0 && t.slice(at + m[0].length).trim() ? [el("p", {}, t.slice(at + m[0].length).replace(/^[\s、。]+/, ""))] : []), ...body.filter((x) => x.tagName === "UL")];
        }
      }
      box.append(el("div", { class: "ki" }, el("div", { class: "kh" }, ...head), el("div", { class: "kb" }, ...(big ? [big] : []), ...body)));
    }
    box.querySelectorAll(".sel, .csel").forEach((x) => x.classList.remove("sel", "csel"));
    return box;
  };
  const hlTable = (c) => c.querySelectorAll("table.mdt").forEach((t) => {   // columns and rows matching HL ("recommended", "our company", "this time") get pale orange (the template deck's "pale orange for highlighted rows only")
    [...(t.rows[0]?.cells || [])].forEach((h, ci) => { if (HL.test(h.textContent)) [...t.rows].forEach((r) => r.cells[ci]?.classList.add("khl")); });
    [...t.rows].slice(1).forEach((r) => { if (HL.test(r.cells[0]?.textContent || "")) r.classList.add("khl"); });
  });
  // section → {ty (type), units, extra (source blocks of merged subheadings)} or null. blks is the content without the message
  const typed = (sec, blks, msg) => {
    if (!TYPES.length) return null;
    const n = (k) => blks.filter((b) => b.dataset.k === k).length, rest = blks.length - n("p");
    const forms = new Set();
    let E = null, kids = false;
    if (sec.kids) { E = entriesOfKids(sec.kids); kids = true; }
    else if (n("ul") === 1 && rest === 1) E = entriesOfList(blks.find((b) => b.dataset.k === "ul").firstChild);
    if (E) for (const [f, ok] of Object.entries(FITS)) if (ok(E, kids)) forms.add(f);
    const tb = blks.find((b) => b.dataset.k === "table"), fig = blks.find((b) => b.dataset.k === "figure");
    if (!kids && tb && rest === 1) { forms.add(gantt(tb) ? "gantt" : "table"); if ((tb.querySelector("tr")?.cells.length || 0) >= 7) forms.add("wide"); }
    if (!kids && fig && rest - n("ul") === 1) forms.add(gantt(fig) ? "gantt" : "figure");
    if (!kids && blks.some((b) => b.querySelector("img"))) forms.add("photo");
    if (!forms.size) return null;
    const hay = [[sec.h ? txt(sec.h) : "", 3], [msg ? txt(msg) : "", 1], [tb ? txt(tb.querySelector("tr") || tb) : "", 2], [E ? E.map((e) => e.title).join(" ") : "", 1], [sec.up.map(txt).join(" "), 1]];
    const ty = pick(forms, hay);
    if (!ty) return null;
    const box = FITS[ty.form] ? formBox(ty.form, E) : null;
    const units = box ? [...(kids ? [] : blks.filter((b) => b.dataset.k === "p")).map((b) => ({ blk: b, c: clean(b) })), { blk: kids ? sec.kids[0].h : blks.find((b) => b.dataset.k === "ul"), c: box }] : unitsOf(blks);
    if (!box) units.forEach((u) => u.c && hlTable(u.c));
    return { ty, units, extra: kids ? sec.kids.flatMap((k) => [k.h, ...k.blks]) : [] };
  };
  const kindOf = (ty) => (ty ? `Content · type ${ty.name}` : "Content");
  const typeAttrs = (ty) => (ty ? { cls: ` k-${ty.form}${["gantt", "wide"].includes(ty.form) ? " pwide" : ""}`, title: `Template deck p.${ty.no} "${ty.name}"${ty.scene ? ` — ${ty.scene}` : ""}` } : { cls: "", title: "" });
  // merging subheadings: 2–6 children, none with grandchildren, no tables/figures, little text, and the parent holds only a message → the children go on one typed slide (only if a type fits)
  if (TYPES.length) for (const s of secs.slice(1)) {
    const ks = secs.filter((x) => x.up.at(-1) === s.h);
    if (ks.length < 2 || ks.length > 6 || s.blks.some((b) => b.dataset.k !== "p") || s.blks.length > 1) continue;
    if (ks.some((k) => !k.blks.length || secs.some((x) => x.up.at(-1) === k.h) || k.blks.some((b) => ["table", "figure", "pre"].includes(b.dataset.k)))) continue;
    if (ks.reduce((a, k) => a + k.blks.map(txt).join("").length, 0) > 1200) continue;
    s.kids = ks;
    if (typed(s, [], s.blks[0])) ks.forEach((k) => { k.absorbed = true; }); else delete s.kids;
  }
  const title = (t, k, m) => (m > 1 ? `${t} (${k}/${m})` : t);
  const retitle = (pages, t) => pages.forEach((p, k) => {   // adding "(n/m)" to the title can wrap it and shrink the area — re-shrink after adding
    p.s.querySelector(".ptitle").textContent = title(t, k + 1, pages.length);
    if (pages.length > 1) { host.append(p.s); shrink(p.a); p.s.remove(); }
  });
  // cover
  const name = f.name.replace(/\.[^.]+$/, "");
  const T = TPLS[tpl] || TPLS.simple, kd = !!(T.cover || T.logo || T.conf || T.copy);
  // a local look (tpl/<name>/tpl.json): the cover has the band picture on the left, the date and the logo; the other sheets the label (conf) and the page number
  // top right, © (copy) bottom left and the logo bottom right. SoloGen v3 takes these from the company template pptx; here md-preview/tpl/make_tpl.py does
  const logo = () => (T.logo ? el("img", { class: "tlogo", src: T.logo, alt: "" }) : ""), conf = () => (T.conf ? el("div", { class: "tconf" }, T.conf) : "");
  out.push({ s: sl("pcover", ...(T.cover ? [el("img", { class: "tband", src: T.cover, alt: "" })] : []), el("div", { class: "pkick" }, parent(f.path).split("/").pop() || ""), el("h1", { class: "pctitle" }, cover ? txt(cover) : name), el("div", { class: "pcsub" }, f.name),
    ...(kd ? [el("div", { class: "tdate" }, new Date().toLocaleDateString("ja-JP")), conf(), logo()] : [])), blks: cover ? [cover] : [], kind: "Cover" });
  const parts = secs.filter((s) => s.h && hlv(s.h) === top);
  const body = (sec, t) => {   // content: the heading as title, the paragraph right below as the message, the rest as figures/tables
    const blks = [...sec.blks], msg = blks[0]?.dataset.k === "p" ? blks.shift() : null;
    const tp = typed(sec, blks, msg), ta = typeAttrs(tp?.ty);
    const mk = () => {
      const a = el("div", { class: "parea" }, el("div", { class: "pfit fdoc md" }));
      const s = sl(`pbody${ta.cls}`, ...(sec.up.length ? [el("div", { class: "pcrumb" }, sec.up.map(txt).join(" › "))] : []),
        el("h2", { class: "ptitle" }, t), ...(msg ? [el("div", { class: "pmsg fdoc md" }, ...clean(msg).childNodes)] : []), a);
      if (ta.title) s.title = ta.title;
      return { s, a };
    };
    const pages = packFew(mk, tp ? tp.units : unitsOf(blks));
    retitle(pages, t);
    return pages.map((p, k) => ({ s: p.s, blks: [...(k ? [] : [sec.h, msg, ...(tp?.extra || [])].filter(Boolean)), ...[...p.blks].filter(Boolean)], kind: kindOf(tp?.ty) }));
  };
  if (secs[0].blks.length) out.push(...body(secs[0], cover ? "Introduction" : name));
  // table of contents (top-level sections; split if it doesn't fit)
  const tocAt = out.length, tocItems = parts.map((s, k) => el("li", {}, el("b", {}, String(k + 1)), el("span", {}, txt(s.h))));
  const toc = parts.length ? packFew(() => { const a = el("div", { class: "parea" }, el("ol", { class: "pfit ptoc" })); return { s: sl("ptocs", el("h2", { class: "ptitle" }, "Contents"), a), a }; }, tocItems.map((c) => ({ blk: null, c }))) : [];
  retitle(toc, "Contents");
  toc.forEach((p) => out.push({ s: p.s, blks: [], kind: "Contents" }));
  // per top-level section: section divider → content. Lower headings before the first top-level section are plain content
  const chunks = [];   // per top-level section {sec, pages (content slides), own (headings with content)}
  let ch = null;
  for (const sec of secs.slice(1)) {
    if (sec.absorbed) continue;   // subheadings merged into the parent's typed slide
    if (hlv(sec.h) === top) { ch = { sec, pages: [], own: [] }; chunks.push(ch); }
    if (!sec.blks.length && !sec.kids) continue;
    const ps = body(sec, txt(sec.h));
    if (ch) { ch.pages.push(...ps); ch.own.push(sec); } else out.push(...ps);
  }
  const num = (k) => String(k + 1).padStart(2, "0");
  const lis = (a) => (a.length ? [el("ul", { class: "psubs" }, ...a.slice(0, 8).map((t) => el("li", {}, t)), ...(a.length > 8 ? [el("li", {}, `+${a.length - 8} more`)] : []))] : []);
  const partSl = (no, t, subs, blks) => ({ s: sl("ppart", el("div", { class: "pnum" }, no), el("h2", { class: "pptitle" }, t), ...lis(subs)), blks, kind: "Section" });
  // When divider + one content slide repeats (2026-10-17 "when divider + 1 page repeats over several pages, merge them into one section or one page"):
  //   merge the following top-level sections onto one slide while they fit at MIN (title "A / B", each section's heading inside); if they fit on one, that's all.
  //   If not, use one divider (numbered "02–04", with each section's title below) followed by the slides. If the run covers all sections and there is a contents slide, that divider equals the contents, so it is skipped
  const mergedMk = (g) => () => {
    const a = el("div", { class: "parea" }, el("div", { class: "pfit fdoc md" }));
    return { s: sl("pbody", el("h2", { class: "ptitle" }, g.map((c) => txt(c.sec.h)).join(" / ")), a), a };
  };
  const ownUnits = (s) => {   // one section inside a merged slide: the message stays a paragraph; the rest uses the type's layout if there is one
    const blks = [...s.blks], msg = blks[0]?.dataset.k === "p" ? blks.shift() : null, tp = typed(s, blks, msg);
    return [...(msg ? unitsOf([msg]) : []), ...(tp ? tp.units : unitsOf(blks))];
  };
  const mergedUnits = (g) => g.flatMap((c) => c.own.flatMap((s) => [{ blk: s.h, c: el("div", { class: "blk" }, el("h3", {}, [...s.up, s.h].map(txt).join(" › "))) }, ...ownUnits(s)]));
  const fits = (g) => pack(mergedMk(g), mergedUnits(g), MIN).length === 1;
  const go = (c, k) => { tocItems[chunks.indexOf(c)].dataset.go = String(k); };
  for (let i = 0; i < chunks.length;) {
    let j = i;
    while (j < chunks.length && chunks[j].pages.length === 1) j++;
    if (j - i < 2) {   // a normal top-level section
      const c = chunks[i], subs = secs.filter((s) => s.up.at(-1) === c.sec.h).map((s) => txt(s.h));
      go(c, out.length); out.push(partSl(num(i), txt(c.sec.h), subs, [c.sec.h]), ...c.pages);
      i++; continue;
    }
    const run = chunks.slice(i, j), groups = [[run[0]]];
    // a typed slide is not merged (2026-10-24: keep one type per slide of the template deck). The dividers are merged into one as below
    const own1 = (c) => c.pages[0].kind !== "Content";
    for (const c of run.slice(1)) { const g = groups.at(-1); if (!own1(c) && !g.some(own1) && fits([...g, c])) g.push(c); else groups.push([c]); }
    if (groups.length > 1 && !(run.length === chunks.length && toc.length)) {
      const ts = run.map((c) => txt(c.sec.h)), t = ts.join(" · ");
      out.push(partSl(`${num(i)}–${num(j - 1)}`, t.length <= 36 ? t : `${ts[0]} and ${ts.length - 1} more`, ts, run.map((c) => c.sec.h)));
    }
    for (const g of groups) {
      if (g.length === 1) { go(g[0], out.length); out.push(...g[0].pages); continue; }
      const pages = packFew(mergedMk(g), mergedUnits(g)), t = g.map((c) => txt(c.sec.h)).join(" / ");
      g.forEach((c) => go(c, out.length));
      retitle(pages, t);
      pages.forEach((p, k) => { out.push({ s: p.s, blks: [...(k ? [] : g.map((c) => c.sec.h)), ...[...p.blks].filter(Boolean)], kind: "Content" }); });
    }
    i = j;
  }
  if (kd) out.forEach((o, k) => { if (k) o.s.append(conf(), el("div", { class: "tpno" }, String(k + 1)), T.copy ? el("div", { class: "tcopy" }, T.copy) : "", logo()); });   // decorations outside the frame (added after layout — they don't affect measuring)
  return out;
}
function present(f, tpl = TPL_MAIN) {
  const body = $("#fbody"), md = f.kind === "md";
  const src = md ? [...body.querySelectorAll(".fdoc > .blk")] : [...body.querySelectorAll(".pg")].filter((g) => g.querySelector("img"));
  if (!src.length) return;
  const top = body.parentElement.getBoundingClientRect().top;
  let at = src.find((x) => x.classList.contains("sel") || x.querySelector(".sel")) || src.find((x) => x.getBoundingClientRect().bottom > top + 8) || src[0];
  const stage = el("div", { class: "pstage" }), no = el("span", { class: "pno" }), host = el("div", { class: "phost", "aria-hidden": "true" });
  const deck = el("div", { class: "pdeck", role: "dialog", "aria-modal": "true", "aria-label": `Presentation — ${f.name}`, tabindex: "-1" }, stage,
    el("div", { class: "pfoot" }, no, el("span", { class: "phelp" }, "← → to move · Esc to exit")),
    btn(mui("Close"), () => close(), { class: "pclose", title: "End presentation (Esc)", "aria-label": "End presentation" }), host);
  let slides = [], i = 0, port = null, PW = 1280, PH = 720;
  const build = () => {   // md: choose the sheet by screen orientation and lay out (re-lay out when it changes)
    port = innerHeight > innerWidth; [PW, PH] = port ? [720, 1160] : [1280, 720];
    slides = deckOf(src, f, host, PW, PH, tpl);
  };
  const fit = () => {   // one slide fills the frame
    const box = stage.firstChild, inner = box?.firstChild;
    if (!inner) return;
    const W = stage.clientWidth * (md ? 0.98 : 0.92), H = stage.clientHeight * (md ? 0.98 : 0.9);
    if (!md) { const im = inner.querySelector("img"), r = (im.naturalHeight || 3) / (im.naturalWidth || 4); inner.style.width = `${Math.min(W, H / r)}px`; return; }
    const s = Math.min(W / PW, H / PH);
    inner.style.transform = `scale(${s})`; box.style.width = `${PW * s}px`; box.style.height = `${PH * s}px`;
  };
  // paged files get a sharper image that fits the screen (2026-10-17 "if the resolution is low, keep it from looking rough when blown up full screen for presenting"):
  //   show the normal image (1280 wide) at once, then swap in one wide enough for the full-screen width × DPR (1920, 2560, 3840) when it arrives. The neighbouring slides are requested ahead too
  const HW = [1920, 2560, 3840].find((w) => w >= screen.width * devicePixelRatio) || 3840;
  const hd = (k) => { const u = src[k].querySelector("img").src; return f.kind === "pages" && u.includes("page=") ? `${u}&w=${HW}` : u; };
  const show = (n) => {
    const all = md ? slides : src;
    i = Math.max(0, Math.min(all.length - 1, n));
    const im = md ? null : el("img", { src: src[i].querySelector("img").src, alt: `Page ${i + 1}` });
    if (im && hd(i) !== im.src) {
      const pre = new Image(), k = i;
      pre.onload = () => { if (im.isConnected && k === i) { im.src = pre.src; im.dataset.hd = HW; } };
      pre.src = hd(i);
      [i + 1, i - 1].forEach((j) => { if (src[j]) new Image().src = hd(j); });
    }
    const inner = md ? slides[i].s : el("div", { class: "pin pimg" }, im);
    stage.replaceChildren(el("div", { class: "pbox" }, inner));
    no.textContent = `${i + 1} / ${all.length}${md ? ` · ${slides[i].kind}` : ""}`;
    fit();
    inner.querySelector("img")?.addEventListener("load", fit, { once: true });
  };
  const count = () => (md ? slides : src).length;
  const key = (e) => {
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); return close(); }
    const d = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k) ? 1 : ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k) ? -1 : 0;
    if (d || k === "Home" || k === "End") { e.preventDefault(); e.stopPropagation(); show(k === "Home" ? 0 : k === "End" ? count() - 1 : i + d); }
  };
  stage.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (a) { if (a.target !== "_blank") e.preventDefault(); return; }   // outside links open a new tab; inside links do nothing (not even advance)
    const g = e.target.closest("[data-go]");
    if (g) return show(+g.dataset.go);   // a contents item → its section divider
    const r = stage.getBoundingClientRect();
    show(i + (e.clientX < r.left + r.width / 2 ? -1 : 1));
  });
  const resize = () => {
    if (md && port !== (innerHeight > innerWidth)) { const b = slides[i]?.blks[0]; build(); const k = slides.findIndex((s) => s.blks.includes(b)); show(k < 0 ? 0 : k); return; }
    fit();
  };
  const fsx = () => { if (!document.fullscreenElement && deck.isConnected && deck.dataset.fs) close(); };   // left full screen with Esc = exit
  const was = document.activeElement;
  function close() {
    if (!deck.isConnected) return;
    window.removeEventListener("keydown", key, true); window.removeEventListener("resize", resize); document.removeEventListener("fullscreenchange", fsx);
    deck.remove();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else unfull();   // the shell put this frame in full screen (▶ in its bar): only the shell can take it out
    was?.focus?.();
  }
  window.addEventListener("keydown", key, true); window.addEventListener("resize", resize); document.addEventListener("fullscreenchange", fsx);
  deck.closeDeck = close;
  document.body.append(deck);
  deck.focus();
  if (md) { build(); const k = slides.findIndex((s) => s.blks.includes(at)); show(k < 0 ? 0 : k); } else show(src.indexOf(at));
  deck.requestFullscreen?.().then(() => { deck.dataset.fs = "1"; resize(); }).catch(() => {});
}
})();
