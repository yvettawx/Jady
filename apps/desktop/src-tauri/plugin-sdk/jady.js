// What a plugin page uses to talk to Jady (docs/extending/external-plugins.md). Load it with
// <script src="/_sdk/jady.js"></script>. Everything goes to the app as a message and comes back as a
// promise; the app checks each call against what you granted the plugin.
(() => {
  "use strict";
  const host = window.parent;
  const pending = new Map();
  const commands = new Map();
  const changed = new Set();
  const ready = [];
  let info = null;
  let seq = 0;

  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      host.postMessage({ jady: 1, id, method, args: args ?? {} }, "*");
    });

  const theme = (tokens) => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tokens ?? {})) root.style.setProperty(k, v);
  };

  // Plain defaults on the app's tokens, so a page looks at home without any styles of its own.
  const base = document.createElement("style");
  base.textContent =
    "html{color-scheme:light dark}body{margin:0;padding:var(--dem-space-3,12px);" +
    "font:var(--dem-text-md,14px)/1.5 var(--dem-font-ui,system-ui);color:var(--dem-text);" +
    "background:transparent}button{font:inherit}";
  document.head.prepend(base);

  window.addEventListener("message", (e) => {
    // Only the app speaks for the app: another plugin's frame can post here too.
    if (e.source !== host) return;
    const m = e.data;
    if (!m || m.jady !== 1) return;
    if (m.reply) {
      const p = pending.get(m.reply);
      if (!p) return;
      pending.delete(m.reply);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
      return;
    }
    if (m.event === "init") {
      info = m.info;
      theme(info.theme);
      document.documentElement.lang = info.locale;
      ready.splice(0).forEach((f) => f(info));
    } else if (m.event === "theme") theme(m.tokens);
    else if (m.event === "command") commands.get(m.id)?.();
    else if (m.event === "changed") changed.forEach((f) => f());
  });

  window.jady = Object.freeze({
    /** Runs `f({ plugin, panel, locale })` once the app has said hello. */
    ready: (f) => (info ? f(info) : ready.push(f)),
    /** The interface language, such as `zh-CN` or `en`. */
    get locale() {
      return info?.locale ?? "en";
    },
    /** Which panel this page is, or `null` for the background page that runs commands. */
    get panel() {
      return info?.panel ?? null;
    },
    items: Object.freeze({
      search: (query, limit) => call("items.search", { query, limit }),
      list: (opts) => call("items.list", opts ?? {}),
      get: (id) => call("items.get", { id }),
      create: (item) => call("items.create", item),
      update: (id, changes) => call("items.update", { id, ...changes }),
      types: () => call("items.types"),
    }),
    storage: Object.freeze({
      get: () => call("storage.get"),
      set: (value) => call("storage.set", { value }),
    }),
    ui: Object.freeze({
      toast: (text) => call("ui.toast", { text: String(text) }),
      openItem: (id) => call("ui.openItem", { id }),
      openPanel: (id) => call("ui.openPanel", { id }),
    }),
    /** Runs `f` when the user picks one of this plugin's commands without a panel. */
    onCommand: (id, f) => void commands.set(id, f),
    /** Runs `f` whenever an item changes, so lists can refresh. */
    onChanged: (f) => void changed.add(f),
  });

  host.postMessage({ jady: 1, hello: true }, "*");
})();
