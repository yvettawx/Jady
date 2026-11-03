# 插件接口

这一页讲构建时带上的插件：和软件编译在一起，权限和软件一样大，给改软件本身的开发者用。要写别人能装的插件，看 [external-plugins.md](external-plugins.md)，那种在沙箱里运行。

类型定义在 `apps/desktop/src/plugins/api.ts`，可运行的完整例子在 `apps/desktop/src/plugins/_example/`。

## 结构

```tsx
// src/plugins/my-plugin/index.tsx
import { definePlugin } from "../api";
import messages from "./messages.json";

export default definePlugin({
  id: "my-plugin",
  activate(ctx) {
    for (const [locale, table] of Object.entries(messages))
      ctx.addMessages(locale, table);
    ctx.registerCommand({
      id: "my-plugin.hello",
      title: ctx.t("my-plugin.hello"),
      run: () => ctx.toast({ text: ctx.t("my-plugin.hi") }),
    });
  },
});
```

`activate` 在资料库打开时运行。注册的东西在资料库锁定时自动撤掉，不用自己清理。如果开了定时器之类的东西，从 `activate` 返回一个函数，停止时会调用它。

## 版本

`apiVersion` 写插件是按哪个接口版本写的，现在是 `1`（`PLUGIN_API_VERSION`）。接口只有在会弄坏已有插件时才升版本，新增东西不升。插件要求的版本比软件新时，这个插件不启动，其他照常。

## ctx 里有什么

| 名字                               | 做什么                             |
| ---------------------------------- | ---------------------------------- |
| `t(key, vars)`                     | 取当前语言的文字                   |
| `addMessages(locale, table)`       | 加文字，键名用插件 id 开头         |
| `data`                             | 读写内容，见下                     |
| `workspace()`                      | 工作区，可以开关页签，见下         |
| `registerPanel(def)`               | 登记面板                           |
| `registerCommand(cmd)`             | 登记命令，自动进启动器和快捷键设置 |
| `registerLauncherSource(source)`   | 给 ⌘K 加结果                       |
| `registerHomeWidget(widget)`       | 首页加小组件                       |
| `registerNavView(view)`            | 最左边的栏加一个视图               |
| `registerSettingsSection(section)` | 设置加一个分区                     |
| `registerScheme(id, sets)`         | 加一套配色                         |
| `toast(content)`                   | 显示提示条                         |

## 面板

```tsx
ctx.registerPanel({
  id: "my-panel",
  icon: "read",
  role: "widget", // 工具用 widget，内容用 content
  render: ({ tabId, contentId, params, workspace }) => <div>…</div>,
});
ctx.workspace()?.open({
  contentId: "my-panel",
  title: ctx.t("my.title"),
  component: "my-panel",
});
```

`icon` 只能用 `src/ui/icons.ts` 里的名字。React 组件里取文字用 `useT()`，这样换语言能跟着变。

现成组件在 `src/ui/`：`Button`、`TextField`、`Select`、`Switch`、`Slider`、`Segmented`、`Menu`、`Dialog`、`Tree`、`Tags`、`EmptyState`。尽量用它们，外观和键盘操作都是对的。

## 命令

```ts
ctx.registerCommand({
  id: "my.command",
  title: ctx.t("my.command"),
  shortcut: "Mod+Shift+J", // Mod 在 Mac 上是 ⌘
  icon: "read",
  run: () => {},
  changesSettings: false, // 会改设置的必须写 true
});
```

快捷键冲突时用户可以在设置里改，不用插件管。

## 启动器结果

```ts
ctx.registerLauncherSource({
  id: "my-source",
  modes: ["search"],
  order: 20, // 内容是 0，命令是 10，数字小的排前面
  search: (q, launcher) => [
    {
      id: "my:1",
      group: ctx.t("my.group"),
      title: "…",
      run: () => launcher.close(),
    },
  ],
});
```

## 首页小组件

小组件就是一个面板，加上它在 12 列网格里的位置：

```ts
ctx.registerHomeWidget({
  id: "my",
  panel: "my-panel",
  title: "my.title",
  col: 9,
  row: 0,
  w: 3,
  h: 2,
});
```

`title` 是语言表的键。

## 侧栏视图

```ts
ctx.registerNavView({ id: "my", icon: "read", label: "my.title", render: ({ workspace }) => <MyList workspace={workspace} /> });
```

`label` 是语言表的键。

## 设置分区

```ts
ctx.registerSettingsSection({ id: "my", icon: "settings", Body: MySection });
```

标题取语言表的 `settings.section.my`。每一项用 `SettingRow`，设置页的搜索才能找到它。

## 配色

```ts
import sets from "./scheme.json"; // [["#2f7d5b", "#7fb069", "#d9c56f"], …]

ctx.registerScheme("my-scheme", sets as unknown as SchemeSets);
```

三组颜色，每组三个，对应空间可以选的三套颜色。名字取语言表的 `scheme.my-scheme`。颜色放 JSON 文件：组件代码里不写颜色值，测试会查。

## 读写内容

`ctx.data` 和界面用的是同一个核心门面。

```ts
const notes = await ctx.data.itemList({
  typeId: "note",
  states: ["active"],
  container: null,
  tag: null,
  order: "updated",
  limit: 50,
});
await ctx.data.itemCreate({
  typeId: "note",
  title: "…",
  state: null,
  container: null,
  privacy: null,
  fields: null,
  tags: null,
  due: null,
  markdown: "正文，用 Markdown",
});
ctx.data.changed(); // 写完告诉列表刷新
```

`itemUpdate(id, patch)` 只改给了的键。`null` 表示清空。`fields` 是 JSON 字符串。类型都在 `src/bindings.ts`。

**隐私：** 列表里的机密内容没有标题，搜索搜不到。`itemGet` 能取到标题，所以取到 `privacy` 是 `confidential` 的内容时，自己不要显示，除非用户已经通过了验证。

## AI

```ts
await ctx.ask(
  { session: "plain", mode: "chat", title: ctx.t("my.title") },
  "第一句话，可以不给",
);
```

`session` 决定 AI 能读什么：`plain` 只有普通内容，能上网；`authorized` 还能读敏感内容，不能上网，只有用户自己发起才用；`webAuthorized` 能上网，敏感内容只有标过联网授权的。插件没有绕过这些规则的办法：AI 只通过网关拿数据，改动都进提议队列。

要接入新的 AI，见 [ai-provider.md](ai-provider.md)。

## 工作区

```ts
const ws = ctx.workspace();
ws?.open({ contentId: id, title, component: "note" }, { kind: "temp" });
ws?.tabs();
ws?.subscribe(() => {});
```

`src/workspace/api.ts` 有全部方法。
