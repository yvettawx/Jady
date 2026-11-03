// A whole plugin in one file: a panel that lists recent items with their length, and a command that
// notes the total. It asks for items:read and items:create, nothing else.
const TEXT = {
  "zh-CN": { total: "共 {n} 字", refresh: "刷新", note: "最近的字数", logged: "记好了，共 {n} 字" },
  en: { total: "{n} words in all", refresh: "Refresh", note: "Recent word count", logged: "Noted: {n} words" },
};
const say = (key, n) => {
  const lang = TEXT[jady.locale] ? jady.locale : jady.locale.startsWith("zh") ? "zh-CN" : "en";
  return TEXT[lang][key].replace("{n}", String(n));
};

// Han characters count one each; everything else counts by words.
function length(text) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? [];
  return han + words.length;
}

async function recent() {
  const items = await jady.items.list({ limit: 20 });
  const out = [];
  for (const it of items) {
    const full = await jady.items.get(it.id);
    out.push({ id: it.id, title: it.title ?? "", n: length(full.markdown) });
  }
  return out;
}

async function draw() {
  const rows = await recent();
  document.getElementById("total").textContent = say(
    "total",
    rows.reduce((a, r) => a + r.n, 0),
  );
  const list = document.getElementById("list");
  list.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = r.title;
      const n = document.createElement("span");
      n.textContent = String(r.n);
      li.append(title, n);
      li.onclick = () => jady.ui.openItem(r.id);
      return li;
    }),
  );
}

jady.ready(({ panel }) => {
  if (panel) {
    const button = document.getElementById("refresh");
    button.textContent = say("refresh");
    button.onclick = draw;
    jady.onChanged(draw);
    draw();
  } else {
    // The background page: commands without a panel arrive here.
    jady.onCommand("log", async () => {
      const rows = await recent();
      const total = rows.reduce((a, r) => a + r.n, 0);
      await jady.items.create({
        typeId: "note",
        title: `${say("note")} ${new Date().toISOString().slice(0, 10)}`,
        markdown: rows.map((r) => `- ${r.title}: ${r.n}`).join("\n"),
        tags: ["word-count"],
      });
      jady.ui.toast(say("logged", total));
    });
  }
});
