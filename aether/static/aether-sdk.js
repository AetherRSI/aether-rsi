// AetherRSI extension SDK (protocol 0.1). Include with <script src="aether-sdk.js"></script> ―― the core inlines it into your page.
// Your page runs in a sandboxed iframe; this is the only channel to the core (spec/v0.1.md §3).
// 🖱 aetherUI: what a mouse or keyboard can use on this page, numbered, and the actions on it (spec/v0.1.md §4.4). The shell uses it for
// itself and asks a framed page that loads this file for its own ("ui" → "ui.reply"), so an agent that hears the person can drive both.
window.aetherUI = window.aetherUI || (function () {
  const SEL = 'button, a[href], input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], '
    + '[role=menuitemcheckbox], [role=option], [role=treeitem], [role=switch], [role=checkbox], [role=radio], [role=slider], [role=separator][tabindex], '
    + '[contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"]), [onclick]';
  const OUTER = 'button, a[href], summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=treeitem], [role=checkbox], [role=radio], [role=switch]';   // a control: what sits inside it is part of it
  let map = new Map();
  const clip = (t, n = 80) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
  const roleOf = (e) => e.getAttribute("role") || ({ A: "link", BUTTON: "button", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" }[e.tagName])
    || (e.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button" }[e.type] || "textbox") : e.isContentEditable ? "textbox" : "clickable");
  const nameOf = (e) => clip(e.getAttribute("aria-label") || e.title || (e.labels && e.labels[0] && e.labels[0].innerText) || e.innerText || e.placeholder || e.alt
    || (e.querySelector && e.querySelector("img[alt]") && e.querySelector("img[alt]").alt) || e.value || e.name || e.id);
  const areaOf = (e) => { const a = e.parentElement && e.parentElement.closest("dialog, [role=dialog], [role=menu], [role=listbox], form, section, header, nav, aside, main");
    return a ? clip(a.getAttribute("aria-label") || (a.querySelector("h1,h2,h3") || {}).innerText || a.id || a.tagName.toLowerCase(), 40) : ""; };
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || +cs.opacity === 0 || e.closest("[hidden], [inert], [aria-hidden=true]")) return null;
    return r;
  };
  const cover = (e, r) => {   // what a click at its middle would hit, when that is not it (null: free)
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)), t = document.elementFromPoint(x, y);
    return !t || t === e || e.contains(t) || t.contains(e) ? null : t;
  };
  function snapshot(skip) {
    map = new Map();
    const items = [], taken = new Set(), dlg = document.querySelector("dialog[open]");
    let n = 0;
    const pointer = [...document.querySelectorAll("body *")].filter((e) => !e.matches(SEL) && getComputedStyle(e).cursor === "pointer"
      && !(e.parentElement && getComputedStyle(e.parentElement).cursor === "pointer"));   // a div with only a click handler: the hand cursor gives it away (outermost one)
    const all = new Set([...document.querySelectorAll(SEL), ...pointer]);
    for (const e of [...all].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))) {
      if (skip && e.closest(skip)) continue;
      if (dlg && !dlg.contains(e)) continue;   // a modal dialog: only it can be used
      if (e.disabled && roleOf(e) === "textbox") continue;
      const r = shown(e);
      if (!r || cover(e, r)) continue;
      if (!e.matches("input, textarea, select") && e.parentElement && taken.has(e.parentElement.closest(OUTER))) continue;   // a control inside another: the outer one is the target
      map.set(++n, e); taken.add(e);
      const st = {};
      for (const [k, a] of [["disabled", "disabled"], ["checked", "aria-checked"], ["expanded", "aria-expanded"], ["pressed", "aria-pressed"], ["selected", "aria-selected"]]) {
        const v = k === "disabled" ? e.disabled || e.getAttribute("aria-disabled") === "true" : e.getAttribute(a);
        if (v === true || v === "true") st[k] = true; else if (v === "false" && k !== "disabled") st[k] = false;
      }
      if (e.type === "checkbox" || e.type === "radio") st.checked = e.checked;
      const it = { n, role: roleOf(e), name: nameOf(e), area: areaOf(e) };
      if (Object.keys(st).length) it.state = st;
      if ("value" in e && it.role === "textbox" && e.value) it.value = clip(e.value, 120);
      if (e.tagName === "SELECT") it.options = [...e.options].map((o) => clip(o.text, 30)).slice(0, 20);
      items.push(it);
    }
    const f = document.activeElement;
    return { title: document.title, dialog: dlg ? clip((dlg.querySelector("h1,h2,h3") || dlg).innerText, 80) : "", focus: f && f !== document.body ? nameOf(f) : "", items };
  }
  function flash(e) {
    const r = e.getBoundingClientRect(), d = document.createElement("div");
    d.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #e8710a;border-radius:6px;`
      + "box-shadow:0 0 0 4px rgba(232,113,10,.25);pointer-events:none;z-index:2147483647;transition:opacity .4s";
    document.body.append(d); setTimeout(() => { d.style.opacity = "0"; }, 700); setTimeout(() => d.remove(), 1200);
  }
  const KEYS = { enter: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", backspace: "Backspace", delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
  function press(target, keys) {
    const parts = String(keys || "").split("+").map((x) => x.trim()).filter(Boolean), raw = parts.pop() || "", mod = new Set(parts.map((x) => x.toLowerCase()));
    const key = KEYS[raw.toLowerCase()] || raw, o = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true,
      metaKey: mod.has("meta") || mod.has("cmd") || mod.has("command"), ctrlKey: mod.has("ctrl") || mod.has("control"), altKey: mod.has("alt") || mod.has("option"), shiftKey: mod.has("shift") };
    const t = target || document.activeElement || document.body;
    const go = t.dispatchEvent(new KeyboardEvent("keydown", o));
    if (go && key === "Enter" && !o.metaKey && !o.ctrlKey && t.form && t.tagName === "INPUT") t.form.requestSubmit ? t.form.requestSubmit() : t.form.submit();   // what Enter in a field does
    t.dispatchEvent(new KeyboardEvent("keyup", o));
    return `pressed ${keys}`;
  }
  function act(q) {
    if (q.op === "snapshot") return snapshot(q.skip);
    if (q.op === "key" && q.n == null) return press(null, q.keys);
    if (q.op === "scroll" && q.n == null) { (document.scrollingElement || document.body).scrollBy(0, +q.dy || 400); return "scrolled the page"; }
    const e = map.get(+q.n);
    if (!e || !e.isConnected) throw new Error(`no item ${q.n} on screen now: take a new snapshot`);
    e.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = shown(e);
    if (!r) throw new Error(`item ${q.n} is not on screen any more: take a new snapshot`);
    if (q.op === "click") {
      const c = cover(e, r);
      if (c) throw new Error(`item ${q.n} is covered by ${nameOf(c) || c.tagName.toLowerCase()}`);
      flash(e);
      const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
      e.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true })); e.dispatchEvent(new MouseEvent("mousedown", at));
      if (e.focus) e.focus({ preventScroll: true });
      e.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true })); e.dispatchEvent(new MouseEvent("mouseup", at));
      e.click();
      return `clicked ${nameOf(e)}`;
    }
    if (q.op === "type") {
      flash(e); e.focus({ preventScroll: true });
      const text = String(q.text ?? "");
      if (e.tagName === "SELECT") {
        const o = [...e.options].find((x) => x.text.trim() === text.trim() || x.value === text) || [...e.options].find((x) => x.text.includes(text));
        if (!o) throw new Error(`no option "${text}"`);
        e.value = o.value; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (e.isContentEditable) {
        if (q.append !== true) document.execCommand("selectAll"); document.execCommand("insertText", false, text);
      } else if ("value" in e) {
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), "value").set;   // the native setter: frameworks see it
        set.call(e, q.append === true ? e.value + text : text);
        e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); e.dispatchEvent(new Event("change", { bubbles: true }));
      } else throw new Error(`item ${q.n} is not a field`);
      if (q.enter) press(e, "Enter");
      return `typed into ${nameOf(e)}`;
    }
    if (q.op === "key") { flash(e); e.focus({ preventScroll: true }); return press(e, q.keys); }
    if (q.op === "scroll") {
      let s = e; while (s && s !== document.body && !(s.scrollHeight > s.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s && s !== document.body ? s : document.scrollingElement).scrollBy(0, +q.dy || 400);
      return "scrolled";
    }
    throw new Error(`unknown op ${q.op}`);
  }
  return { snapshot, act, flash };
})();
if (window.parent !== window) (function () {   // the SDK proper: only in a framed page (the shell loads this file for aetherUI alone)
  const PROTOCOL = "0.1";
  const handlers = {};
  const pending = {};
  let seq = 0, runs = {};
  const post = (type, data) => parent.postMessage({ aether: PROTOCOL, type, ...data }, "*");
  window.addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data.type !== "string") return;
    const d = e.data;
    if (d.type === "reply" && pending[d.id]) { const p = pending[d.id]; delete pending[d.id]; return d.ok ? p.ok(p.raw ? d : d.text) : p.ng(new Error(d.error)); }
    if (d.type === "bar" && runs[d.id]) runs[d.id](d.value);
    if (d.type === "ui") { let r; try { r = { ok: true, result: window.aetherUI.act(d) }; } catch (err) { r = { ok: false, error: err.message }; } return post("ui.reply", { id: d.id, ...r }); }   // 🖱 spec §4.4
    (handlers[d.type] || []).forEach((f) => f(d));
  });
  const ask = (type, data, raw = false) => { const id = ++seq; return new Promise((ok, ng) => { pending[id] = { ok, ng, raw }; post(type, { id, ...data }); }); };
  window.aether = {
    protocol: PROTOCOL,
    /** core → you: "open" {path, name, text? | data? (ArrayBuffer, when the manifest says "binary": true), folder?, top?, state?, error?} · "rev" {rev} · "dest" {task} · "theme" {dark} · "scroll.to" {top} · "bar" {id, value} · "fullscreen" {on} */
    on(type, f) { (handlers[type] ||= []).push(f); },
    /** Add a quote chip to the composer. The user sends it (with @n) ―― you never send on your own. */
    quote(label, text) { post("quote.add", { label, text }); },
    /** Put text into the composer (not sent). */
    send(text) { post("send", { text }); },
    /** Open a task's conversation. */
    openTask(id) { post("task.open", { id }); },
    /** Read a text file inside your own folder (apps: the app folder · previews: the extension folder). */
    read(path) { return ask("read", { path }); },
    /** Apps: fetch from a server on this machine whose port the app's aether.json names in "ports" (url: http://127.0.0.1:<port>/…; GET, or POST with a string body).
     *  The shell fetches it for you ―― behind a cookie-authenticated relay your own requests carry no cookie. Resolves to a Response; rejects like fetch when it cannot reach. */
    fetch(url, { method = "GET", body, headers = {} } = {}) {
      const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
      return ask("fetch", { url: String(url), method, body: body == null ? undefined : String(body), contentType }, true).then(
        (d) => new Response([204, 205, 304].includes(d.status) ? null : d.data, { status: d.status, statusText: d.statusText, headers: d.contentType ? { "Content-Type": d.contentType } : {} }),
        (e) => { throw new TypeError(e.message); });
    },
    /** Previews whose aether.json names "render" (a command the core runs, spec §3.2): the pages it drew of the open file.
     *  Resolves to {state: "ready"|"stale"|"none", running, error, key, dir, pages: [names], data: [ArrayBuffer]} ―― stale: drawn for an older
     *  version of the file (show it, then ask again with wait). force: draw again. wait: answer when the drawing ends.
     *  page + width (1920 · 2560 · 3840): that page drawn larger → {key, name, file, data: ArrayBuffer}. */
    render({ force = false, wait = false, page = 0, width = 0 } = {}) { return ask("render", { force, wait, page, width }, true); },
    /** Follow a link: an http(s)/mailto URL opens in a new tab; otherwise a workspace file or folder opens in the shell (path relative to the workspace, rejects if missing). */
    open(path, hash) { if (/^(https?|mailto):/i.test(path)) { post("url.open", { url: path }); return Promise.resolve(""); } return ask("file.open", { path, hash }); },
    /** Tell the shell where you are scrolled to, so ← → can come back here. */
    scrolled(top) { post("scroll", { top }); },
    /** Remember a small JSON value (≤ 4 KB) for your extension in this browser. It comes back as "open" {state}. */
    save(value) { post("state", { value }); },
    /** Ask the shell to download the file you are showing (the original bytes) ―― or, given name and data (an ArrayBuffer), bytes you made (a video you encoded…).
     *  The frame has no allow-downloads; data is handed over (transferred), so do not use it afterwards. */
    download(name, data, mime = "") {
      if (!(data instanceof ArrayBuffer)) return post("download", {});
      parent.postMessage({ aether: PROTOCOL, type: "download", name: String(name || "download"), mime: String(mime), data }, "*", [data]);
    },
    /** Put your own controls in the shell's bar, next to 📎 🔄 (spec §3.1). Replaces the previous ones; [] clears.
     *  items: [{id, label, icon?, title?, primary?, disabled?, options?: [{value, label, icon?, title?, full?} | {head}], select?, value?, full?, run?(value)}]
     *  icon: a Material icon name ("Download"), drawn in one colour before the label (load aether-icons.js to draw the same icons in your page).
     *  run is called on click (or "bar" {id, value} comes to on("bar")). full: the shell makes your frame full screen first. */
    bar(items = []) { runs = {}; post("bar", { items: items.map(({ run, ...x }) => { if (run) runs[x.id] = run; return x; }) }); },
    /** Leave the full screen a "full" control started (your frame cannot: the full-screen element is the shell's). */
    fullscreen(on = false) { if (!on) post("fullscreen", { on: false }); },
  };
})();
