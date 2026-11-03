// The page that shows gallery.mjs's shots: one state at a time, switch engine and light or dark,
// mark it 可以 or 要改 with a note. Marks stay in this browser; the list of what to change can be
// copied out. A review tool for the project's owner, not part of the interface.
const STYLE = `
:root { color-scheme: light dark; --bg:#f5f5f7; --panel:#fff; --line:#d9d9de; --text:#1c1c21;
  --muted:#6c6c76; --accent:#4f5bd5; --ok:#14804a; --fix:#c2410c; }
@media (prefers-color-scheme: dark) { :root { --bg:#17171b; --panel:#222228; --line:#3a3a42;
  --text:#ececf1; --muted:#a0a0ab; --accent:#8d96f5; --ok:#4cc38a; --fix:#f4a261; } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: grid; grid-template-columns: 250px 1fr; background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif; }
nav { overflow: auto; border-right: 1px solid var(--line); background: var(--panel); padding: 12px; }
nav h1 { font-size: 15px; margin: 0 0 2px; }
#progress { color: var(--muted); margin: 0 0 10px; }
nav h2 { font-size: 12px; color: var(--muted); margin: 14px 0 4px; font-weight: 600; }
nav button { display: flex; gap: 8px; align-items: center; width: 100%; padding: 4px 8px; border: 0;
  border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
nav button:hover { background: var(--bg); }
nav button[aria-current=true] { background: var(--accent); color: #fff; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--muted); }
.dot[data-mark=ok] { background: var(--ok); border-color: var(--ok); }
.dot[data-mark=fix] { background: var(--fix); border-color: var(--fix); }
main { display: flex; flex-direction: column; min-width: 0; height: 100vh; }
header, footer { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px; }
header h2 { margin: 0 auto 0 0; font-size: 16px; }
.seg { display: flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.seg button, .act { padding: 4px 12px; border: 0; background: var(--panel); color: inherit; font: inherit; cursor: pointer; }
.seg button[aria-pressed=true] { background: var(--accent); color: #fff; }
.act { border: 1px solid var(--line); border-radius: 7px; }
.act[aria-pressed=true][data-v=ok] { background: var(--ok); color: #fff; }
.act[aria-pressed=true][data-v=fix] { background: var(--fix); color: #fff; }
#note-webkit { margin: 0 14px 8px; color: var(--muted); font-size: 12px; }
figure { flex: 1; min-height: 0; margin: 0 14px; display: flex; align-items: center; justify-content: center; }
figure img { max-width: 100%; max-height: 100%; border: 1px solid var(--line); border-radius: 6px; }
#note { flex: 1; min-width: 200px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--panel); color: inherit; font: inherit; }
kbd { color: var(--muted); font: inherit; font-size: 12px; }
`;

const SCRIPT = `
const flat = GROUPS.flatMap((g) => g.states.map(([id, title]) => ({ id, title, group: g.title })));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const marks = load("gallery.marks", {});
const saveMarks = () => { try { localStorage.setItem("gallery.marks", JSON.stringify(marks)); } catch {} };
let view = { engine: "chromium", mode: "light", i: 0, ...load("gallery.view", {}) };
const $ = (s) => document.querySelector(s);
function render() {
  const s = flat[view.i];
  try { localStorage.setItem("gallery.view", JSON.stringify(view)); } catch {}
  $("#title").textContent = s.group + "：" + s.title;
  $("#shot").src = "screens/" + view.engine + "-" + view.mode + "/" + s.id + ".jpg";
  document.querySelectorAll("[data-engine]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.engine === view.engine));
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === view.mode));
  $("#note-webkit").hidden = view.engine !== "webkit";
  const m = marks[s.id] ?? {};
  document.querySelectorAll(".act[data-v]").forEach((b) => b.setAttribute("aria-pressed", m.v === b.dataset.v));
  $("#note").value = m.note ?? "";
  document.querySelectorAll("nav button").forEach((b) => {
    const id = b.dataset.id;
    b.setAttribute("aria-current", id === s.id);
    b.querySelector(".dot").dataset.mark = marks[id]?.v ?? "";
  });
  const done = flat.filter((x) => marks[x.id]?.v).length;
  const fix = flat.filter((x) => marks[x.id]?.v === "fix").length;
  $("#progress").textContent = "看过 " + done + " / " + flat.length + "，要改 " + fix;
}
function go(d) { view.i = Math.max(0, Math.min(flat.length - 1, view.i + d)); render(); }
function mark(v) {
  const id = flat[view.i].id;
  marks[id] = { ...marks[id], v };
  saveMarks();
  if (v === "ok") go(1); else { render(); $("#note").focus(); }
}
const nav = $("nav");
GROUPS.forEach((g) => {
  const h = document.createElement("h2"); h.textContent = g.title; nav.append(h);
  g.states.forEach(([id, title]) => {
    const b = document.createElement("button"); b.dataset.id = id;
    const d = document.createElement("span"); d.className = "dot";
    b.append(d, title);
    b.onclick = () => { view.i = flat.findIndex((x) => x.id === id); render(); };
    nav.append(b);
  });
});
document.querySelectorAll("[data-engine]").forEach((b) => (b.onclick = () => { view.engine = b.dataset.engine; render(); }));
document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { view.mode = b.dataset.mode; render(); }));
document.querySelectorAll(".act[data-v]").forEach((b) => (b.onclick = () => mark(b.dataset.v)));
$("#note").oninput = (e) => {
  const id = flat[view.i].id;
  marks[id] = { ...marks[id], v: marks[id]?.v ?? "fix", note: e.target.value };
  saveMarks();
};
$("#copy").onclick = async () => {
  const lines = flat.filter((x) => marks[x.id]?.v === "fix")
    .map((x) => "- " + x.id + "（" + x.group + "：" + x.title + "）：" + (marks[x.id].note ?? ""));
  const unseen = flat.length - flat.filter((x) => marks[x.id]?.v).length;
  const text = (lines.length ? "要改：\\n" + lines.join("\\n") : "全部可以。") + (unseen ? "\\n还有 " + unseen + " 项没看。" : "");
  await navigator.clipboard.writeText(text);
  $("#copy").textContent = "已复制";
  setTimeout(() => ($("#copy").textContent = "复制要改的清单"), 1500);
};
addEventListener("keydown", (e) => {
  if (e.target.id === "note") { if (e.key === "Escape") e.target.blur(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowRight") { go(1); e.preventDefault(); }
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") { go(-1); e.preventDefault(); }
  if (e.key === "d") { view.mode = view.mode === "light" ? "dark" : "light"; render(); }
  if (e.key === "e") { view.engine = view.engine === "webkit" ? "chromium" : "webkit"; render(); }
  if (e.key === "y") mark("ok");
  if (e.key === "n") { e.preventDefault(); mark("fix"); }
});
render();
`;

export function buildGalleryPage(groups) {
    const data = JSON.stringify(groups);
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P0.5-07 评审</title><style>${STYLE}</style></head>
<body>
<nav><h1>P0.5-07 界面评审</h1><p id="progress"></p></nav>
<main>
<header><h2 id="title"></h2>
<div class="seg"><button data-engine="chromium">Chromium</button><button data-engine="webkit">WebKit</button></div>
<div class="seg"><button data-mode="light">浅色</button><button data-mode="dark">深色</button></div>
</header>
<p id="note-webkit">Playwright 的 WebKit 不画 CSS 模糊，所以这里的弹窗和浮层背后不模糊，真 Safari 和软件窗口里是好的（验证报告 07）。玻璃效果看 Chromium 那张。</p>
<figure><img id="shot" alt=""></figure>
<footer>
<button class="act" data-v="ok">可以</button><button class="act" data-v="fix">要改</button>
<input id="note" placeholder="哪里要改；只有某一张有问题就写明">
<button class="act" id="copy">复制要改的清单</button>
<kbd>↑↓ 换一项 · D 深浅 · E 内核 · Y 可以 · N 要改</kbd>
</footer>
</main>
<script>const GROUPS = ${data};${SCRIPT}</script>
</body></html>
`;
}
