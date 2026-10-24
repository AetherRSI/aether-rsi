// pptx-preview: the page documents of SoloGen v3's 📂 Files (apps/files/static/view.js) for .pptx, ported to an AetherRSI preview.
(() => {
// The pages are v3's: images LibreOffice drew (render.py, run by the core through the manifest's "render" ―― spec §3.2), with the
// shapes' hit boxes over them. The core draws them once per version of the file, and ahead of time when a job that quoted the file ends.
// "binary": true also hands the bytes over: this page unzips them (DecompressionStream) for the hit boxes and the text, and draws the
// shapes itself by their EMU boxes as % of the slide ―― shown until the images come, and instead of them where LibreOffice is missing
// (text, fills, pictures, tables and groups; not charts, SmartArt or effects).

// ---- zip ----
async function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const files = {}, n = v.getUint16(e + 10, true);
  for (let i = 0, p = v.getUint32(e + 16, true); i < n; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)), local = v.getUint32(p + 42, true);
    files[name] = { method, start: local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true), size };
    p += 46 + nl + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  const cache = {};
  const bytes = (name) => cache[name] ||= (async () => {
    const f = files[name];
    if (!f) return null;
    const raw = u8.subarray(f.start, f.start + f.size);
    if (f.method === 0) return raw;
    return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  })();
  return { bytes, async xml(name) { const b = await bytes(name); return b && new DOMParser().parseFromString(dec.decode(b), "application/xml"); } };
}

// ---- XML helpers (match on localName, so prefixes do not matter) ----
const kids = (el, name) => el ? [...el.children].filter((c) => c.localName === name) : [];
const kid = (el, ...path) => { for (const n of path) el = kids(el, n)[0]; return el || null; };
const deep = (el, name) => el ? [...el.getElementsByTagNameNS("*", name)] : [];
const num = (x, d = 0) => x == null || x === "" ? d : +x;
const dir = (p) => p.slice(0, p.lastIndexOf("/") + 1);
function resolve(base, target) {
  const out = (target.startsWith("/") ? target.slice(1) : dir(base) + target).split("/"), st = [];
  for (const s of out) s === ".." ? st.pop() : s !== "." && st.push(s);
  return st.join("/");
}
async function rels(z, part) {
  const x = await z.xml(`${dir(part)}_rels/${part.slice(dir(part).length)}.rels`), m = {};
  for (const r of deep(x, "Relationship")) m[r.getAttribute("Id")] = { target: resolve(part, r.getAttribute("Target")), type: r.getAttribute("Type").split("/").pop() };
  return m;
}

// ---- colours ----
let THEME = {};
const ALIAS = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
function color(el) {   // a:solidFill / a:fontRef … → "#rrggbb" or null
  if (!el) return null;
  const c = kid(el, "srgbClr") || kid(el, "schemeClr") || kid(el, "sysClr") || kid(el, "prstClr");
  if (!c) return null;
  let hex = c.localName === "srgbClr" ? c.getAttribute("val") : c.localName === "sysClr" ? c.getAttribute("lastClr")
    : c.localName === "schemeClr" ? THEME[ALIAS[c.getAttribute("val")] || c.getAttribute("val")] : ({ black: "000000", white: "FFFFFF" })[c.getAttribute("val")];
  if (!hex) return null;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mod = (n) => { const m = kid(c, n); return m ? num(m.getAttribute("val")) / 1e5 : null; };
  const lm = mod("lumMod"), lo = mod("lumOff"), sh = mod("shade"), ti = mod("tint");
  const f = (x) => { if (lm != null) x = x * lm + (lo || 0) * 255; if (sh != null) x *= sh; if (ti != null) x = x + (255 - x) * (1 - ti); return Math.max(0, Math.min(255, Math.round(x))); };
  return "#" + [r, g, b].map((x) => f(x).toString(16).padStart(2, "0")).join("");
}

// ---- placeholders: a shape without its own box or style takes them from the layout, then the master ----
const phKey = (sp) => { const ph = deep(sp, "ph")[0]; return ph && { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") }; };
function phFind(tree, key) {
  if (!tree || !key) return null;
  const all = deep(tree, "sp").map((s) => [s, phKey(s)]).filter(([, k]) => k);
  const same = (t) => t === key.type || (["title", "ctrTitle"].includes(t) && ["title", "ctrTitle"].includes(key.type));
  return (all.find(([, k]) => key.idx != null && k.idx === key.idx) || all.find(([, k]) => same(k.type)) || [])[0] || null;
}

// ---- one slide ----
let W = 12192000, H = 6858000, N = 0;
const pct = (v, of) => `${(v / of * 100).toFixed(3)}%`;
const cqw = (hundredthsPt) => `${(hundredthsPt / 100 * 12700 / W * 100).toFixed(3)}cqw`;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function box(sp, chain) {   // [x, y, w, h] in EMU, from the shape or its placeholder chain
  for (const s of [sp, ...chain]) { const x = s && (kid(s, "spPr", "xfrm") || kid(s, "xfrm")); if (x && kid(x, "off")) return xywh(x); }
  return null;
}
const xywh = (x) => [num(kid(x, "off").getAttribute("x")), num(kid(x, "off").getAttribute("y")), num(kid(x, "ext")?.getAttribute("cx")), num(kid(x, "ext")?.getAttribute("cy"))];
function lvlStyle(lvl, chain, kind, master) {   // defRPr of this level, nearest first
  const name = `lvl${lvl + 1}pPr`, out = [];
  for (const s of chain) { const p = kid(s, "txBody", "lstStyle", name); if (p) out.push(p); }
  const ms = kid(master, "txStyles", kind === "title" ? "titleStyle" : kind === "other" ? "otherStyle" : "bodyStyle", name);
  if (ms) out.push(ms);
  return out;
}
function text(sp, chain, master) {
  const body = kid(sp, "txBody");
  if (!body) return { html: "", plain: "", raw: "" };
  const key = phKey(sp), kind = !key ? "other" : ["title", "ctrTitle"].includes(key.type) ? "title" : "body";
  const anchor = [sp, ...chain].map((s) => kid(s, "txBody", "bodyPr")?.getAttribute("anchor")).find(Boolean) || (kind === "title" ? "ctr" : "t");
  let html = "", plain = [], raw = [];
  for (const p of kids(body, "p")) {
    const pPr = kid(p, "pPr"), lvl = num(pPr?.getAttribute("lvl")), st = lvlStyle(lvl, chain, kind, master);
    const pick = (a) => [pPr, ...st].map((e) => e?.getAttribute(a)).find((v) => v != null);
    const def = (a) => [kid(pPr, "defRPr"), ...st.map((e) => kid(e, "defRPr"))].map((e) => e?.getAttribute(a)).find((v) => v != null);
    const defColor = [kid(pPr, "defRPr"), ...st.map((e) => kid(e, "defRPr"))].map((e) => color(kid(e, "solidFill"))).find(Boolean) || (!key && color(kid(sp, "style", "fontRef")));
    const bu = [pPr, ...st].map((e) => kid(e, "buNone") || kid(e, "buChar")).find(Boolean);   // the nearest level that says either
    const bullet = bu && bu.localName === "buChar" ? bu.getAttribute("char") + " " : "";
    let line = "", runs = "";
    for (const r of [...p.children].filter((c) => ["r", "fld", "br"].includes(c.localName))) {
      if (r.localName === "br") { runs += "\n"; line += "\n"; continue; }
      const t = kid(r, "t")?.textContent || "", rp = kid(r, "rPr");
      const sz = num(rp?.getAttribute("sz") || def("sz"), kind === "title" ? 4400 : 1800), b = (rp?.getAttribute("b") || def("b")) === "1", i = (rp?.getAttribute("i") || def("i")) === "1";
      const c = color(kid(rp, "solidFill")) || defColor;
      runs += `<span style="font-size:${cqw(sz)};${b ? "font-weight:700;" : ""}${i ? "font-style:italic;" : ""}${c ? `color:${c};` : ""}">${esc(t)}</span>`;
      line += t;
    }
    const algn = { ctr: "center", r: "right", just: "justify" }[pick("algn")] || "left";
    const sz0 = num(def("sz"), kind === "title" ? 4400 : 1800);
    const indent = lvl ? `padding-left:${cqw(lvl * 2400)};` : "";
    html += `<p style="text-align:${algn};font-size:${cqw(sz0)};${indent}margin-top:${p === kids(body, "p")[0] ? 0 : cqw(sz0 * .25)}">${bullet ? `<span>${esc(bullet)}</span>` : ""}${runs || "&#8203;"}</p>`;
    if (line) plain.push((bullet ? "• " : "") + "  ".repeat(lvl) + line);
    if (line.trim()) raw.push(line.trim());
  }
  return { html, plain: plain.join("\n"), raw: raw.join("\n"), anchor: { t: "flex-start", ctr: "center", b: "flex-end" }[anchor] || "flex-start" };
}
// The hit boxes (.bx) follow SoloGen v3's _boxes (apps/files/files.py): top-level shapes only, no slide number / date / footer,
// nothing larger than 0.6 of the slide (a backdrop would cover everything; a range can still be dragged), text → "text",
// table → "text" (cells joined by " | "), picture / group / chart → "pic". Sorted largest first so small boxes sit on top.
const SKIP_PH = ["sldNum", "dt", "ftr"];
const cname = (el) => deep(el, "cNvPr")[0]?.getAttribute("name") || "";
function hit(ctx, b, k, name, text = "", title = false) {
  if (!b || !b[2] || !b[3] || b[2] * b[3] > 0.6 * W * H) return;
  ctx.boxes.push({ k, x: b[0] / W, y: b[1] / H, w: b[2] / W, h: b[3] / H, name, ...(k === "text" ? { text, title } : {}) });
}
async function shapes(z, tree, ctx, off = [0, 0, 1, 1], top = true) {   // off = group transform: x0, y0, scale x, scale y. top = the slide's own shapes (they get hit boxes)
  const out = [];
  const place = (b) => [off[0] + b[0] * off[2], off[1] + b[1] * off[3], b[2] * off[2], b[3] * off[3]];
  for (const el of tree.children) {
    if (el.localName === "grpSp") {
      const x = kid(el, "grpSpPr", "xfrm");
      if (!x) continue;
      const [gx, gy, gw, gh] = xywh(x), ch = kid(x, "chOff"), ce = kid(x, "chExt");
      const sx = ce && num(ce.getAttribute("cx")) ? gw / num(ce.getAttribute("cx")) : 1, sy = ce && num(ce.getAttribute("cy")) ? gh / num(ce.getAttribute("cy")) : 1;
      const [px, py] = place([gx, gy, 0, 0]);
      if (top) hit(ctx, [gx, gy, gw, gh], "pic", cname(el));
      out.push(...await shapes(z, el, ctx, [px - num(ch?.getAttribute("x")) * sx * off[2], py - num(ch?.getAttribute("y")) * sy * off[3], sx * off[2], sy * off[3]], false));
    } else if (el.localName === "sp") {
      const key = phKey(el), chain = key ? [phFind(ctx.layout, key), phFind(ctx.master, key)].filter(Boolean) : [];
      const b = box(el, chain);
      if (!b) continue;
      const t = text(el, chain, ctx.master), spPr = kid(el, "spPr");
      if (top && t.raw && !(key && SKIP_PH.includes(key.type))) hit(ctx, b, "text", cname(el), t.raw, !!key && ["title", "ctrTitle"].includes(key.type));
      const fill = kid(spPr, "noFill") ? null : color(kid(spPr, "solidFill")) || (!key && color(kid(el, "style", "fillRef")));
      const ln = kid(spPr, "ln"), line = ln && !kid(ln, "noFill") ? color(kid(ln, "solidFill")) : null;
      const round = kid(spPr, "prstGeom")?.getAttribute("prst") === "roundRect" ? "border-radius:1.2cqw;" : kid(spPr, "prstGeom")?.getAttribute("prst") === "ellipse" ? "border-radius:50%;" : "";
      const ins = (a, d) => cqw(num(kid(el, "txBody", "bodyPr")?.getAttribute(a), d) / 12700 * 100);
      out.push({ b: place(b), plain: t.plain, label: key ? key.type : "shape",
        html: `<div class="sh" style="${fill ? `background:${fill};` : ""}${line ? `border:.12cqw solid ${line};` : ""}${round}justify-content:${t.anchor};padding:${ins("tIns", 45720)} ${ins("rIns", 91440)} ${ins("bIns", 45720)} ${ins("lIns", 91440)};">${t.html}</div>` });
    } else if (el.localName === "pic") {
      const x = kid(el, "spPr", "xfrm"), id = deep(el, "blip")[0]?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
      const r = id && ctx.rels[id], data = r && await z.bytes(r.target);
      if (top && x) hit(ctx, xywh(x), "pic", cname(el));
      if (!x || !data) continue;
      const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" }[r.target.split(".").pop().toLowerCase()];
      if (!type) continue;   // emf/wmf: browsers cannot draw them
      const name = kid(el, "nvPicPr", "cNvPr")?.getAttribute("descr") || kid(el, "nvPicPr", "cNvPr")?.getAttribute("name") || "picture";
      out.push({ b: place(xywh(x)), plain: `[${name}]`, label: "picture", html: `<div class="sh"><img alt="${esc(name)}" src="${URL.createObjectURL(new Blob([data], { type }))}"></div>` });
    } else if (el.localName === "graphicFrame") {
      const x = kid(el, "xfrm"), tbl = deep(el, "tbl")[0];
      if (x && !tbl && (deep(el, "chart").length || deep(el, "relIds").length)) {   // a chart or SmartArt: not drawn here, so say so where it sits
        const chart = deep(el, "chart").length > 0;
        if (top && chart) hit(ctx, xywh(x), "pic", cname(el));
        out.push({ b: place(xywh(x)), plain: `[${cname(el) || (chart ? "chart" : "SmartArt")}]`, label: chart ? "chart" : "smartart",
          html: `<div class="sh nodraw"><span>${chart ? "Chart" : "SmartArt"} (not drawn in this preview)</span></div>` });
        continue;
      }
      if (!x || !tbl) continue;
      const rows = kids(tbl, "tr").map((tr) => kids(tr, "tc").map((tc) => deep(tc, "t").map((t) => t.textContent).join("")));
      if (top) hit(ctx, xywh(x), "text", cname(el), rows.map((r) => r.map((c) => c.trim()).join(" | ")).join("\n"));
      out.push({ b: place(xywh(x)), plain: rows.map((r) => r.join(" | ")).join("\n"), label: "table",
        html: `<div class="sh"><table style="font-size:${cqw(1800)}">${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>` });
    }
  }
  return out;
}
async function background(ctx) {
  for (const t of [ctx.slide, ctx.layout, ctx.master]) {
    const bg = kid(t, "cSld", "bg");
    if (!bg) continue;
    const c = color(kid(bg, "bgPr", "solidFill")) || color(kid(bg, "bgRef"));
    if (c) return c;
  }
  return "#ffffff";
}


// ---- the page: SoloGen v3's 📂 Files for page documents (apps/files/static/view.js), on the slides drawn above ----
// Click a shape (element) → that element, click outside the shapes → the whole page, drag → that range (✂ Range on touch).
// The bar (spec §3.1) is v3's: ⬇ Download ▾ (download / print) · ▶ Present (one button ―― "no ▼ when a PPTX is selected") · 📎 Add n to quotes · Clear.
// A quote names the page image LibreOffice drew (v3's "Page image: …", so the agent can look at it) and carries the page's text too.
// Drawing them again is the shell's own 🔄 (v3's 🔄 with force=1): it asks the core to draw again, then opens the file anew ――
// this page then shows the pages it gets while the new ones are drawn (2026-10-24 "merge Reload and preview refresh").
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
const btn = (label, fn, attrs = {}) => { const b = el("button", Object.assign({ type: "button" }, attrs), label); b.addEventListener("click", fn); return b; };
const ICON = "📑";
const QUOTE_MAX = 20000;   // the body of one quote (characters)
let SEL = null;   // the open file and what is picked {f: {path, name}, items: [{t:"page"|"el"|"rect", n, …}]}
let GEN = 0, URLS = [], DRAWN = false;   // GEN: which open the answers belong to · URLS: blob URLs of page images (freed on the next open) · DRAWN: LibreOffice's pages are shown
const unfull = () => (aether.fullscreen ? aether.fullscreen(false) : parent.postMessage({ aether: "0.1", type: "fullscreen", on: false }, "*"));

function drawBar() {
  if (!SEL) return aether.bar([]);
  const f = SEL.f, n = SEL.items.length;
  aether.bar([
    { id: "dl", icon: "Download", label: "Download", title: `Download ${f.name}`, run: (v) => (v === "print" ? printView(f) : aether.download()),
      options: [{ value: "dl", icon: "Download", label: "Download", title: "Save the original file as is" }, { value: "print", icon: "Print", label: "Print (PDF)", title: "Print the current preview (choose \"Save as PDF\" as the destination)" }] },
    { id: "present", icon: "Slideshow", label: "Present", full: true, title: "Show one page per slide in full screen ―― ← → to move · Esc to exit", run: () => present(f) },
    ...(n ? [{ id: "quote", icon: "AttachFile", label: `Add ${n} to quotes`, primary: true, title: `Add the ${n} selected item(s) to the quotes in ③`, run: quotePicked },
      { id: "clear", label: "Clear", run: clearSel }] : []),
  ]);
}

// Phones (finger): drag = vertical scroll · tap = pick. Dragging a range only with [✂ Range] on. The button shows on touch devices only (@media (pointer: coarse))
function rngBtn() {
  $("#fbody").classList.remove("rng");
  const b = el("button", { type: "button", class: "frng", "aria-pressed": "false", title: "When on, a finger drag selects a range (no vertical scrolling over the pages meanwhile)" }, mui("HighlightAlt", { class: "lead" }), "Range");
  b.onclick = () => { const on = $("#fbody").classList.toggle("rng"); b.setAttribute("aria-pressed", String(on)); b.replaceChildren(mui("HighlightAlt", { class: "lead" }), on ? "Range on" : "Range"); };
  return b;
}
const bxHead = (b) => b.k === "text" ? (b.text || "").split("\n")[0].slice(0, 30) : b.name;
function page(n, slide, boxes, texts) {
  const w = el("div", { class: "pg", "data-n": String(n) }, slide);
  w.texts = texts;
  for (const b of boxes) {
    const x = el("span", { class: `bx ${b.k}`, title: b.k === "text" ? `Text: ${bxHead(b)}` : `Figure: ${b.name}` });
    Object.assign(x.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
    x.box = b;
    w.append(x);
  }
  w.append(el("span", { class: "pno" }, `p.${n}`));
  w.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".rect")) return;
    const pan = e.pointerType === "touch" && !$("#fbody").classList.contains("rng");   // a finger drag scrolls; lifting without moving picks
    if (!pan) e.preventDefault();
    let moved = false;
    const r = w.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const box = el("div", { class: "rect live" });
    const pct = (x, y) => [Math.max(0, Math.min(100, (x - r.left) / r.width * 100)), Math.max(0, Math.min(100, (y - r.top) / r.height * 100))];
    const move = (ev) => {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 6) return;
      if (pan) { moved = true; return; }
      if (!box.isConnected) w.append(box);
      const [a, b] = pct(x0, y0), [c, d] = pct(ev.clientX, ev.clientY);
      Object.assign(box.style, { left: `${Math.min(a, c)}%`, top: `${Math.min(b, d)}%`, width: `${Math.abs(c - a)}%`, height: `${Math.abs(d - b)}%` });
    };
    const up = (ev) => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up);
      if (ev.type === "pointercancel" || (pan && moved)) { box.remove(); return; }
      const bx = !box.isConnected && e.target.closest(".bx");
      if (bx) {   // released on an element without moving = that element
        const has = SEL.items.findIndex((it) => it.t === "el" && it.el === bx);
        if (has >= 0) SEL.items.splice(has, 1); else SEL.items.push({ t: "el", n, b: bx.box, el: bx });
        bx.classList.toggle("sel", has < 0);
      } else if (!box.isConnected) {   // released without moving = the whole page
        const has = SEL.items.findIndex((it) => it.t === "page" && it.n === n);
        if (has >= 0) SEL.items.splice(has, 1); else SEL.items.push({ t: "page", n, w });
        w.classList.toggle("sel", has < 0);
      } else {
        const [a, b] = pct(x0, y0), [c, d] = pct(ev.clientX, ev.clientY), it = { t: "rect", n, w, x1: Math.round(Math.min(a, c)), y1: Math.round(Math.min(b, d)), x2: Math.round(Math.max(a, c)), y2: Math.round(Math.max(b, d)) };
        box.classList.remove("live"); box.title = "Click to remove";
        box.addEventListener("click", (ev2) => { ev2.stopPropagation(); SEL.items.splice(SEL.items.indexOf(it), 1); box.remove(); drawBar(); });
        SEL.items.push(it);
      }
      drawBar();
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up);
  });
  return w;
}
function clearSel() {
  document.querySelectorAll("#fbody .sel").forEach((x) => x.classList.remove("sel"));
  document.querySelectorAll("#fbody .rect").forEach((x) => x.remove());
  if (SEL) SEL.items = [];
  drawBar();
}
// → quotes. Each starts with "<path> page n". Labels carry no file name (the shell puts "📄 path ·" in front)
const pic = (w, sep = "") => (w?.img ? (sep ? `${sep}page image: ${w.img}` : ` (page image: ${w.img})`) : "");   // v3: the image LibreOffice drew
const qt = (t) => { t = t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}… (truncated)` : t; return t.split("\n").map((l) => `  > ${l}`).join("\n"); };
function quotePicked() {
  const f = SEL.f;
  for (const p of SEL.items) {
    const where = `page ${p.n}`;
    let label, text;
    if (p.t === "page") {
      const t = p.w.texts.join("\n");
      [label, text] = [`p.${p.n}`, `${ICON} ${f.path} ${where}${pic(p.w)}${t ? `:\n${qt(t)}` : " (no text)"}`];
    } else if (p.t === "el") {   // element: the shape's name, position and text (long text is cut)
      const b = p.b, pos = `shape "${b.name}" · ${Math.round(b.x * 100)}–${Math.round((b.x + b.w) * 100)}% from left · ${Math.round(b.y * 100)}–${Math.round((b.y + b.h) * 100)}% from top`;
      [label, text] = b.k === "text"
        ? [`p.${p.n} "${bxHead(b)}"`, `${ICON} ${f.path} ${where}, ${b.title ? "title" : "text"} (${pos}${pic(p.el.parentElement, " · ")}):\n${qt(b.text || "")}`]
        : [`p.${p.n} figure "${b.name}"`, `${ICON} ${f.path} ${where}, figure (${pos}${pic(p.el.parentElement, " · ")})`];
    } else {   // range: add the text of the elements inside it (there is no image, so the text records what was pointed at)
      const inside = [...p.w.querySelectorAll(".bx.text")].map((x) => x.box).filter((b) => b.x * 100 >= p.x1 - 1 && b.y * 100 >= p.y1 - 1 && (b.x + b.w) * 100 <= p.x2 + 1 && (b.y + b.h) * 100 <= p.y2 + 1);
      const t = inside.sort((a, b) => a.y - b.y || a.x - b.x).map((b) => b.text).join("\n");
      [label, text] = [`p.${p.n} range`, `${ICON} ${f.path} ${where}, the range ${p.x1}–${p.x2}% from left · ${p.y1}–${p.y2}% from top${pic(p.w)}${t ? ` (text inside):\n${qt(t)}` : ""}`];
    }
    aether.quote(label, text);
  }
  clearSel();
}

// 🖨 Print: the current pages one per sheet (choose "Save as PDF" as the destination)
const slideCopy = (g) => { const s = g.querySelector(".slide").cloneNode(true); s.querySelectorAll(".bx, .pno, .rect").forEach((x) => x.remove()); return s; };
async function printView(f) {
  const kids = [...$("#fbody").querySelectorAll(".pg")].map((g) => el("div", { class: "ppg" }, slideCopy(g)));
  if (!kids.length) return;
  return printKids(f.name, `
    html, body { height: auto; display: block; }
    body { margin: 0; padding: 0 4mm; background: #fff; color: #1d2433; font: 14px/1.7 -apple-system, "Hiragino Sans", sans-serif; }
    h1.ptitle { font-size: 12px; color: #667; font-weight: 400; margin: 0 0 8px; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .ppg { break-after: page; break-inside: avoid; } .ppg:last-child { break-after: auto; } .ppg .slide { max-width: none; box-shadow: none; border: 1px solid #e3e6ee; }
    @page { margin: 12mm; }
`, kids, `<h1 class="ptitle">${esc(f.path)}</h1>`);
}
async function printKids(title, style, kids, head = "") {   // put the copies (kids) on this page and print this page (only the copies show while printing). style = CSS for the copies only
  // SoloGen v3 prints from a hidden iframe, but this frame is sandboxed (opaque origin) and cannot touch a child iframe's document ―― so it prints itself
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

// ▶ Present: one page per slide in full screen (as v3's page documents ―― ← → or click the left/right half to move · Esc to exit)
function present(f) {
  const body = $("#fbody"), src = [...body.querySelectorAll(".pg")];
  if (!src.length) return;
  const top = body.parentElement.getBoundingClientRect().top;
  const at = src.find((x) => x.classList.contains("sel") || x.querySelector(".sel")) || src.find((x) => x.getBoundingClientRect().bottom > top + 8) || src[0];
  const stage = el("div", { class: "pstage" }), no = el("span", { class: "pno" });
  const deck = el("div", { class: "pdeck", role: "dialog", "aria-modal": "true", "aria-label": `Present ―― ${f.name}`, tabindex: "-1" }, stage,
    el("div", { class: "pfoot" }, no, el("span", { class: "phelp" }, "← → to move · Esc to exit")),
    btn(mui("Close"), () => close(), { class: "pclose", title: "End presentation (Esc)", "aria-label": "End presentation" }));
  let i = 0;
  const fit = () => {   // fit one slide to the frame
    const inner = stage.firstChild?.firstChild;
    if (!inner) return;
    const Wv = stage.clientWidth * 0.92, Hv = stage.clientHeight * 0.9;
    inner.style.width = `${Math.min(Wv, Hv * W / H)}px`;
  };
  // v3: the normal image (width 1280) at once, then the page drawn at the screen's width × DPR (1920 · 2560 · 3840) when it comes;
  // the pages before and after are asked for too. Only LibreOffice's pages (the browser's drawing is sharp at any size)
  const HW = [1920, 2560, 3840].find((w) => w >= screen.width * devicePixelRatio) || 3840, big = {};
  const large = (k) => (big[k] ||= src[k].pn && src[k].querySelector(".slide img")
    ? aether.render({ page: src[k].pn, width: HW, wait: true }).then((r) => (r.data ? png(r.data) : null), () => null) : Promise.resolve(null));
  const show = (n) => {
    i = Math.max(0, Math.min(src.length - 1, n));
    const copy = slideCopy(src[i]), k = i;
    stage.replaceChildren(el("div", { class: "pbox" }, el("div", { class: "pin pimg" }, copy)));
    no.textContent = `${i + 1} / ${src.length}`;
    fit();
    large(k).then((u) => { const im = copy.querySelector("img"); if (u && im && k === i && im.isConnected) { im.src = u; im.dataset.hd = HW; } });
    [k + 1, k - 1].forEach((j) => src[j] && large(j));
  };
  const key = (e) => {
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); return close(); }
    const d = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k) ? 1 : ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k) ? -1 : 0;
    if (d || k === "Home" || k === "End") { e.preventDefault(); e.stopPropagation(); show(k === "Home" ? 0 : k === "End" ? src.length - 1 : i + d); }
  };
  stage.addEventListener("click", (e) => {
    const r = stage.getBoundingClientRect();
    show(i + (e.clientX < r.left + r.width / 2 ? -1 : 1));
  });
  const resize = () => fit();
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
  show(src.indexOf(at));
  deck.requestFullscreen?.().then(() => { deck.dataset.fs = "1"; resize(); }).catch(() => {});
}

// ---- the pages LibreOffice drew (render.py through the core ―― spec §3.2) ----
// ready: shown as they are (running too: 🔄 is drawing them again) · stale: drawn for an older version of the file, shown while the
// core draws again · none: the browser's drawing until they come · error: the browser's drawing stays (LibreOffice missing…), 🔄 tries again.
const png = (b) => { const u = URL.createObjectURL(new Blob([b], { type: "image/png" })); URLS.push(u); return u; };
function note(text, spin = false, err = false) {
  const h = $("#fbody .rstate");
  if (h) { h.className = `rstate${err ? " rerr" : ""}`; h.replaceChildren(...(spin ? [el("span", { class: "spin" })] : []), text); }
}
function apply(r) {   // put the drawn pages on the slides (hidden slides are not in the pdf: the images go to the shown ones)
  if (!r.data?.length) return false;
  const all = [...$("#fbody").querySelectorAll(".pg")], shown = all.filter((g) => !g.hidden_);
  const to = r.data.length === all.length ? all : r.data.length === shown.length ? shown : all;
  to.forEach((g, k) => {
    if (!r.data[k]) return;
    const s = g.querySelector(".slide");
    s.replaceChildren(el("img", { src: png(r.data[k]), alt: `Page ${g.dataset.n}`, draggable: "false" }));
    s.classList.add("drawn");
    g.img = `${r.dir}/${r.pages[k]}`;   // the quote names it
    g.pn = +(r.pages[k].match(/\d+/) || [k + 1])[0];   // the page of the pdf (a larger one is asked for by it)
  });
  DRAWN = true;
  return true;
}
async function drawn(gen) {
  let r;
  try { r = await aether.render(); }
  catch (e) { if (gen === GEN) note(`Quick view (${e.message})`, false, true); return; }
  if (gen !== GEN) return;
  apply(r);
  if (r.running) {   // ready + running: 🔄 asked for them again
    note(r.state === "none" ? "Quick view ―― rendering page images (the first time can take tens of seconds)" : `Showing ${r.state === "stale" ? "the previous version's" : "the current"} images ―― re-rendering…`, true);
    try { r = await aether.render({ wait: true }); } catch (e) { r = { error: e.message }; }
    if (gen !== GEN) return;
    apply(r);
  }
  if (r.state === "ready") note("");
  else note(`${DRAWN ? "Previous version's images" : "Quick view"} (could not render page images: ${r.error || "unknown"} ―― reload above to try again)`, false, true);
}

// ---- the deck ----
let scrollT = 0;
$(".fmain").addEventListener("scroll", () => { clearTimeout(scrollT); scrollT = setTimeout(() => aether.scrolled($(".fmain").scrollTop), 150); }, { passive: true });
aether.on("scroll.to", (d) => { $(".fmain").scrollTop = +d.top || 0; });
aether.on("fullscreen", (d) => { if (!d.on) document.querySelector(".pdeck")?.closeDeck?.(); });
aether.on("open", async (d) => {
  const body = $("#fbody"), gen = ++GEN;
  document.querySelector(".pdeck")?.closeDeck?.();
  SEL = null; DRAWN = false;
  URLS.forEach((u) => URL.revokeObjectURL(u)); URLS = [];
  if (d.error) { drawBar(); body.replaceChildren(el("p", { class: "ferr" }, mui("Cancel", { class: "lead" }), d.error)); return; }
  const f = { path: d.path, name: d.name };
  try {
    const z = await unzip(d.data), pres = await z.xml("ppt/presentation.xml");
    if (!pres) throw new Error("ppt/presentation.xml is missing ―― is this a .pptx?");
    const sz = kid(pres.documentElement, "sldSz");
    W = 12192000; H = 6858000;
    if (sz) { W = num(sz.getAttribute("cx"), W); H = num(sz.getAttribute("cy"), H); }
    const prels = await rels(z, "ppt/presentation.xml");
    const themePart = Object.values(prels).find((r) => r.type === "theme");
    THEME = {};
    const scheme = themePart && deep(await z.xml(themePart.target), "clrScheme")[0];
    for (const c of scheme ? [...scheme.children] : []) THEME[c.localName] = kid(c, "srgbClr")?.getAttribute("val") || kid(c, "sysClr")?.getAttribute("lastClr");
    const ids = kids(kid(pres.documentElement, "sldIdLst"), "sldId").map((s) => s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
    const pages = [];
    let nb = 0;
    for (const [k, id] of ids.entries()) {
      const part = prels[id].target, n = k + 1;
      const r = await rels(z, part), layoutPart = Object.values(r).find((x) => x.type === "slideLayout")?.target;
      const masterPart = layoutPart && Object.values(await rels(z, layoutPart)).find((x) => x.type === "slideMaster")?.target;
      const sx = await z.xml(part), lx = layoutPart && await z.xml(layoutPart), mx = masterPart && await z.xml(masterPart);
      const ctx = { slide: sx.documentElement, layout: lx?.documentElement, master: mx?.documentElement, rels: r, boxes: [] };
      const hidden = ctx.slide.getAttribute("show") === "0";   // LibreOffice leaves hidden slides out of the pdf
      const list = await shapes(z, kid(ctx.slide, "cSld", "spTree"), ctx);
      const slide = el("div", { class: "slide" });
      slide.style.aspectRatio = `${W} / ${H}`;
      slide.style.background = await background(ctx);
      for (const s of list) {
        const t = document.createElement("template");
        t.innerHTML = s.html;
        const e = t.content.firstElementChild;
        Object.assign(e.style, { left: pct(s.b[0], W), top: pct(s.b[1], H), width: pct(s.b[2], W), height: pct(s.b[3], H) });
        slide.append(e);
      }
      const boxes = ctx.boxes.sort((a, b) => b.w * b.h - a.w * a.h);   // largest first ―― later ones sit on top, so small boxes stay clickable
      nb += boxes.length;
      const pg = page(n, slide, boxes, list.map((s) => s.plain).filter(Boolean));
      pg.hidden_ = hidden;
      pages.push(pg);
    }
    SEL = { f, items: [] };
    body.replaceChildren(el("p", { class: "fhint" }, `${ids.length} pages. ${nb ? "Click text or a figure (element) to pick it, " : ""}${nb ? "click" : "Click"} outside elements to pick the whole page, drag to pick a range`, rngBtn(),
      el("span", { class: "rstate" })), ...pages);
    drawBar();
    if (d.top) $(".fmain").scrollTop = d.top;
    drawn(gen);
  } catch (e) { drawBar(); body.replaceChildren(el("p", { class: "ferr" }, mui("Cancel", { class: "lead" }), `Could not read "${f.name}": ${e.message}`)); }
});
})();
