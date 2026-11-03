---
name: dem-app-tools
description: 给 Jady 的 AI 加一个不读库内容的工具，比如专用浏览器那样操作外部程序的工具。当用户想让 AI 多一种能力、而这种能力和库里的条目无关时用。
---

# 给 AI 加软件自己的工具

先读 `docs/extending/app-tools.md`，再读 `CLAUDE.md` 的硬性规则，尤其是 AI 权限那几条。

## 先判断

- 要读或改库里的内容：不是这里，加到 `crates/dem-core/src/ai_tools.rs`，那里有受限视图和提议队列。
- 会把东西送出电脑（上网、发消息、提交表单）：只能给能上网的会话，授权读取敏感内容的会话不行；对外发东西前要用户确认。
- 涉及放宽 AI 的权限：停下来问用户。CLAUDE.md 的规则要用户同意才改。

## 做法

1. 实现 `dem_ai_gateway::AppTools`，参考 `apps/desktop/src-tauri/src/browser.rs` 的 `BrowserTools`。
2. 在 `ai.rs` 的 `ai_start` 里按会话类型决定给不给，写一个纯函数并测试它（参考 `gets_browser`）。
3. 开关放在设置里，只有界面能改，不加 AI 工具去改它。
4. 界面文字进 `zh-CN.json` 和 `en.json`。
5. 同步更新 `docs/extending/app-tools.md`。

## 验证

```bash
cargo test -p dem-ai-gateway
cargo test -p dem-desktop
cargo xtask ci
```

告诉用户哪些在真实环境里测过、哪些没有。提交说明用中文。
