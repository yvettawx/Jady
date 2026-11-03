# 外部插件

不用改软件、不用开发环境，写一个文件夹就能给 Jady 加面板和命令。插件跑在沙箱里：不能上网，只看得到普通内容，你批准过的权限之外什么都做不了。为什么这样挡得住，见 [../spikes/plugin-sandbox.md](../spikes/plugin-sandbox.md)。

能跑的完整例子在 `examples/plugins/word-count/`：一个面板列出最近改过的条目各有多少字，一个命令把总数记成笔记。

## 试一下例子

1. 打开 Jady，设置 › 插件 › 安装，选 `examples/plugins/word-count` 文件夹。
2. 打开它的开关，看一眼它要的权限，点“启用”。
3. ⌘K 输入“字数统计”打开面板；输入“记下最近的总字数”运行命令。

改了插件的文件，再装一次就会替换旧的。也可以点“打开文件夹”，直接改装好的那份，然后关掉再打开开关重新加载。

## 文件夹里有什么

```
word-count/
  manifest.json   必须有
  index.html      必须有：面板和后台都打开这一页
  main.js         其余随意：脚本、样式、图片、WebAssembly
  style.css
```

### manifest.json

```json
{
  "id": "word-count",
  "name": { "zh-CN": "字数统计", "en": "Word count" },
  "version": "1.0.0",
  "apiVersion": 1,
  "description": { "zh-CN": "……", "en": "……" },
  "permissions": ["items:read", "items:create"],
  "panels": [{ "id": "main", "title": { "zh-CN": "字数统计", "en": "Word count" } }],
  "commands": [
    { "id": "open", "title": { "zh-CN": "字数统计", "en": "Word count" }, "panel": "main" },
    { "id": "log", "title": { "zh-CN": "记下最近的总字数", "en": "Note the recent word count" } }
  ]
}
```

- `id`：小写字母、数字和连字符，最多 40 个字符。装好后文件夹就叫这个名字。
- `name`、`title`、`description`：按语言写。找不到当前语言时依次用不带地区的语言、英文、第一个。
- `apiVersion`：现在是 `1`。比软件新的插件装不上。
- `permissions`：见下面。写错一个字，整个插件就装不上。
- `panels`：每个面板出现在 ⌘K 和工作区里，打开的是 `index.html?panel=<id>`。
- `commands`：出现在 ⌘K。带 `panel` 的打开那个面板；不带的发给后台页面，由 `jady.onCommand` 处理。

多写了不认识的字段也装不上，这样拼错的字段不会被悄悄忽略。

## 权限

| 权限 | 能做什么 |
| --- | --- |
| `items:read` | 搜索、列出、读取普通内容 |
| `items:create` | 新建条目（只能建默认隐私是普通的类型；状态是收集箱或进行中） |
| `items:write` | 修改它能读到的条目：标题、正文、标签、字段。要同时申请 `items:read` |

不管申请什么，插件都看不到敏感、私密、机密内容、回收站和密码库，碰不到设置，不能删除，不能改隐私层级，也不能上网。插件更新后多要了权限，会自动停用，等用户重新同意。

## 页面里怎么写

在 `index.html` 里先加载 SDK，再加载自己的脚本：

```html
<script src="/_sdk/jady.js"></script>
<script src="main.js" defer></script>
```

所有调用都返回 Promise；被拒绝时抛出错误，错误信息说明原因。

```js
jady.ready(({ plugin, panel, locale }) => {
  // panel 是面板 id；后台页面是 null
});

await jady.items.search("关键词", 20);  // [{ id, typeId, title, tags, state, created, updated, fields, snippet }]
await jady.items.list({ typeId: "note", tag: "读书", limit: 50 });
await jady.items.get(id);               // 同上，再加 markdown（正文）
await jady.items.types();               // [{ id, name, builtin, fields: [{ key, name }] }]
await jady.items.create({ typeId: "note", title: "…", markdown: "…", tags: [], fields: {}, state: "inbox" });
await jady.items.update(id, { title, markdown, tags, fields });

await jady.storage.get();               // 插件自己的一块存储，存在这个库的本机设置里
await jady.storage.set({ any: "json" }); // 最多 1 MB

jady.ui.toast("文字");                   // 提示前面总会带上插件名
jady.ui.openItem(id);                    // 只能打开它读得到的
jady.ui.openPanel("main");
jady.onCommand("log", () => { … });      // 后台页面收命令
jady.onChanged(() => { … });             // 有条目变了（要有 items:read）
jady.locale;                             // "zh-CN"、"en" ……
```

- **样式**：SDK 会把软件的设计令牌（`--dem-*` 变量）放到页面上，跟着浅色、深色和空间颜色一起变。直接写 `color: var(--dem-text)` 就行，背景留透明。
- **多语言**：界面文字按 `jady.locale` 自己选。
- **不能用的**：`fetch`、外部图片和字体、`localStorage`、弹出窗口、表单提交、嵌套页面。都会被浏览器拦下，在控制台里能看到原因。
- **WebAssembly** 可以用，`.wasm` 文件放在文件夹里加载。

## 调试

- 设置 › 插件里，装不上的插件会写“这个文件夹不是能用的插件”。原因在开发版的诊断日志里。
- 开发版（`pnpm tauri dev`）里右键插件面板，选“检查元素”，就能看插件页面的控制台。

## 和构建时带上的插件的区别

`apps/desktop/src/plugins/<name>/` 是另一种插件，见 [plugin-api.md](plugin-api.md)。它和软件编译在一起，能用全部界面组件，权限和软件一样大，适合改软件本身的开发者。给别人装的，一律写外部插件。
