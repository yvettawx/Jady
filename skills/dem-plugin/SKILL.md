---
name: dem-plugin
description: 给 Jady 写插件：面板、命令、启动器结果、首页小组件、侧栏视图、设置分区、配色。当用户想给这个软件加功能、加面板或写插件时用。
---

# 写一个插件

先读 `docs/extending/README.md` 和 `docs/extending/plugin-api.md`。接口定义在 `apps/desktop/src/plugins/api.ts`，这是唯一可信的来源，文档和代码不一致时听代码的。

## 步骤

1. 问清楚用户想要什么，用一句话说明你打算加哪些东西（面板、命令等）。
2. 复制例子开始：`cp -r apps/desktop/src/plugins/_example apps/desktop/src/plugins/<名字>`。名字用小写字母和连字符，不能以 `_` 开头。
3. 删掉用不上的注册，改 `id`，把 `messages.json` 的键名改成以插件 id 开头。
4. 写功能。组件优先用 `src/ui/` 里现成的，样式只用 `--dem-` 令牌。
5. 验证：

   ```bash
   cd apps/desktop
   pnpm run check
   pnpm run probe:app
   ```

6. 让用户运行 `pnpm tauri dev` 看效果。

## 一定要做到

- 界面文字全部进语言表，至少有 `zh-CN`，最好也给 `en`。代码里写中文，`check` 会失败。
- 数据只用 `ctx.data`。不要导入 `src/app/api.ts` 以外的通道，不要碰文件系统。
- 写完数据调 `ctx.data.changed()`。
- 机密内容（`privacy === "confidential"`）的标题和正文不要显示，也不要写日志。
- 会改设置的命令加 `changesSettings: true`。
- 文案按 `docs/05-design.md` 第 14 节：按钮只写动作，不要“XX · XX”，不要长破折号，中文和数字之间留空格。

## 做不到的

- 增加正文的节点或标记：那是存储格式，要走格式升级。告诉用户并停下来问。
- 接入新的 AI：见 `skills/dem-ai-provider/SKILL.md`。在插件里开一个 AI 对话可以，用 `ctx.ask`。
- 不重新构建就加载：现在插件是构建时带上的。
