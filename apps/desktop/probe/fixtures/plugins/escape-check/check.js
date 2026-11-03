// Tries every way out of the sandbox it knows and writes what happened into #out as JSON. Each entry
// is true when the way was closed. The probe reads it (probe/plugins.mjs).
const out = {};
const blocked = [];
document.addEventListener("securitypolicyviolation", (e) => blocked.push(e.violatedDirective));

const closed = async (name, attempt) => {
  try {
    const r = await attempt();
    out[name] = r === "closed";
  } catch {
    out[name] = true;
  }
};

jady.ready(async () => {
  await closed("parentDocument", () => window.parent.document.body.innerHTML);
  await closed("topLocation", () => window.top.location.href);
  await closed("localStorage", () => localStorage.getItem("x"));
  await closed("tauri", () => (window.__TAURI_INTERNALS__ ? "open" : "closed"));
  await closed("parentTauri", () => window.parent.__TAURI_INTERNALS__.invoke);
  await closed("fetchWeb", () => fetch("https://example.com/").then(() => "open"));
  await closed("fetchHome", () =>
    fetch(`${location.protocol}//${location.host}/local_get`, { method: "POST" }).then(
      () => "open",
    ),
  );
  await closed("ipc", () =>
    fetch("ipc://localhost/local_get", { method: "POST" }).then(() => "open"),
  );
  await closed(
    "image",
    () =>
      new Promise((ok) => {
        const img = new Image();
        img.onload = () => ok("open");
        img.onerror = () => ok("closed");
        img.src = "https://example.com/favicon.ico";
      }),
  );
  await closed("popup", () => (window.open("https://example.com/") ? "open" : "closed"));
  await closed("create", () =>
    jady.items.create({ typeId: "note", title: "escape" }).then(() => "open"),
  );
  await closed("privacy", () =>
    jady.items
      .update("019a0000-0000-7000-8000-000000000000", { privacy: "normal" })
      .then(() => "open"),
  );
  const found = await jady.items.search("canary-plugin");
  out.found = found.map((h) => h.title);
  out.violations = blocked.length;
  document.getElementById("out").textContent = JSON.stringify(out);
});
