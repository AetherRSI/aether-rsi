// AetherRSI extension SDK (protocol 0.1). Include with <script src="aether-sdk.js"></script> ―― the core inlines it into your page.
// Your page runs in a sandboxed iframe; this is the only channel to the core (spec/v0.1.md §3).
(function () {
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
     *  items: [{id, label, title?, primary?, disabled?, options?: [{value, label, title?, full?} | {head}], select?, value?, full?, run?(value)}]
     *  run is called on click (or "bar" {id, value} comes to on("bar")). full: the shell makes your frame full screen first. */
    bar(items = []) { runs = {}; post("bar", { items: items.map(({ run, ...x }) => { if (run) runs[x.id] = run; return x; }) }); },
    /** Leave the full screen a "full" control started (your frame cannot: the full-screen element is the shell's). */
    fullscreen(on = false) { if (!on) post("fullscreen", { on: false }); },
  };
})();
