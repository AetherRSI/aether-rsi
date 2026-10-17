// AetherRSI extension SDK (protocol 0.1). Include with <script src="aether-sdk.js"></script> ―― the core inlines it into your page.
// Your page runs in a sandboxed iframe; this is the only channel to the core (spec/v0.1.md §3).
(function () {
  const PROTOCOL = "0.1";
  const handlers = {};
  const pending = {};
  let seq = 0;
  const post = (type, data) => parent.postMessage({ aether: PROTOCOL, type, ...data }, "*");
  window.addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data.type !== "string") return;
    const d = e.data;
    if (d.type === "reply" && pending[d.id]) { const p = pending[d.id]; delete pending[d.id]; return d.ok ? p.ok(d.text) : p.ng(new Error(d.error)); }
    (handlers[d.type] || []).forEach((f) => f(d));
  });
  window.aether = {
    protocol: PROTOCOL,
    /** core → you: "open" {path, name, text?, folder?, error?} · "rev" {rev} · "dest" {task} · "theme" {dark} */
    on(type, f) { (handlers[type] ||= []).push(f); },
    /** Add a quote chip to the composer. The user sends it (with @n) ―― you never send on your own. */
    quote(label, text) { post("quote.add", { label, text }); },
    /** Put text into the composer (not sent). */
    send(text) { post("send", { text }); },
    /** Open a task's conversation. */
    openTask(id) { post("task.open", { id }); },
    /** Apps only: read a text file inside your own folder. */
    read(path) { const id = ++seq; return new Promise((ok, ng) => { pending[id] = { ok, ng }; post("read", { id, path }); }); },
  };
})();
