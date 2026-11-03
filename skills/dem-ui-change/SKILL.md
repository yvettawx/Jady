---
name: dem-ui-change
description: 修改 Jady 现有的界面和交互，或者给界面加需要核心支持的新功能。当用户想改某个页面、按钮、布局、操作方式时用。
---

# 改界面

先读 `docs/extending/ui-changes.md` 找到要改的文件，再读 `CLAUDE.md` 的硬性规则。交互和视觉的依据是 `docs/05-design.md`，涉及设计决定时先看它。

## 先判断

- 新增一块东西（面板、命令、小组件）：能写成插件就写插件，见 `skills/dem-plugin/SKILL.md`。
- 改已有的东西：改源码。
- 需要新的数据操作：按 `docs/extending/ui-changes.md` 里的四步，从 `dem-core` 开始，带测试。
- 要动存储格式、加密、隐私规则，或 AI 能看到什么：停下来问用户。这些有版本和迁移要求。
- 让代码题支持新语言：在 `apps/desktop/src-tauri/src/coderun.rs` 的语言表加一项，见 `docs/extending/README.md` 的“代码题加一种语言”。不要放宽 `crates/dem-sandbox/src/native.rs` 的沙盒规则。

## 改的时候

- 文字进 `src/i18n/zh-CN.json` 和 `en.json`。
- 组件用 `src/ui/`，样式用 `--dem-` 令牌。
- 列表、菜单这种要能扩展的，走登记机制。
- 键盘能操作，焦点不丢。

## 验证

```bash
cd apps/desktop
pnpm run check
pnpm run probe:app
```

改了哪部分就再跑对应的 `probe:*`。提交说明用中文。把看到的结果告诉用户，测试没过要直说。
