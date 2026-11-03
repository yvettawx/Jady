---
name: dem-external-plugin
description: 给 Jady 写一个外部插件：一个文件夹，在沙箱里运行，用户在设置里安装和启用，不用改软件。当用户想写一个能分享给别人装的插件、想在不改源码的情况下加面板或命令时用。
---

# 写一个外部插件

先读 `docs/extending/external-plugins.md`。SDK 在 `apps/desktop/src-tauri/plugin-sdk/jady.js`，manifest 的检查在 `apps/desktop/src-tauri/src/plugins.rs` 的 `read_manifest`，数据调用在 `crates/dem-core/src/plugin_api.rs`。文档和代码不一致时听代码的。

## 步骤

1. 问清楚用户想要什么，用一句话说明要几个面板、几个命令、要哪些权限。权限能少就少。
2. 复制例子：`cp -r examples/plugins/word-count <放插件的地方>/<id>`，`id` 用小写字母、数字和连字符。
3. 改 `manifest.json`：`id` 和文件夹同名，`name`、`title` 至少写 `zh-CN` 和 `en`。
4. 写 `index.html` 和脚本。SDK 用 `<script src="/_sdk/jady.js"></script>` 加载，所有调用等 `jady.ready` 之后再发。
5. 告诉用户怎么装：设置 › 插件 › 安装，选这个文件夹，打开开关并同意权限。改了再装一次就会替换。

## 一定要做到

- 不要尝试联网、读 `localStorage`、开新窗口或提交表单：都会被拦，插件会坏掉。需要存东西用 `jady.storage`。
- 界面文字按 `jady.locale` 选，不要只写一种语言。
- 样式用 `--dem-*` 变量，背景透明，深色模式才会对。
- 调用都可能被拒绝（权限不够、条目看不到），每个 `await` 都要能处理错误。
- 不要在插件面板里让用户输入密码或主密码。软件永远不会在插件面板里要这些，这样的插件会被当成欺骗。

## 不能做、也别绕的

插件看不到敏感、私密、机密内容和密码库，不能删除，不能改隐私层级和设置，不能调用 AI。用户要这些功能时，告诉他们这只能改软件本身（见 `skills/dem-plugin/SKILL.md` 和 `docs/extending/plugin-api.md`），并说明那种插件权限和软件一样大。
