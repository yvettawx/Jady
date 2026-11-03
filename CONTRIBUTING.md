# 参与开发

先读 `docs/extending/README.md`。想加功能，多半写一个插件就够，不用改核心。

## 准备

需要 Rust（版本见 `rust-toolchain.toml`）、Node.js 和 pnpm。目前只支持 macOS。

```bash
cd apps/desktop && pnpm install && pnpm tauri dev
```

## 提交前

```bash
cargo xtask ci
```

它跑格式、lint、测试、依赖许可证和安全公告，以及模块分层规则。界面流程用 `apps/desktop/probe/` 下的端到端脚本，见 `docs/testing.md`。

## 许可和署名

项目用 AGPL-3.0-only，你提交的代码也按它发布，版权仍归你。每个提交都要带 `Signed-off-by`（`git commit -s`），表示你同意 [Developer Certificate of Origin](https://developercertificate.org/)：代码是你写的，或者你有权按这个许可证提交。

## 不能破坏的规则

- **隐私**：AI 只能拿到受限视图。私密、机密内容和密码库在任何情况下都不能出现在 AI 能看到的结果里。相关改动必须带测试。
- **设置**：AI 不能修改，也不能提议修改任何设置。
- **提议队列**：AI 改已有内容一律走提议队列，删除永远要用户确认。
- **密码学**：不自己实现算法，只通过 `dem-crypto` 调用成熟的库。
- **密钥**：API key 只存系统钥匙串，不进代码、配置和日志。日志不记正文。
- **数据入口**：界面和 AI 只通过 `dem-core` 访问数据。分层规则由 `cargo xtask` 检查。
- **存储格式**：改 `docs/format-spec.md` 里规定的任何东西，都要升级格式版本并带迁移和测试。
- **专用浏览器**：只有开着上网的会话能用，只去用户列的网站，AI 的操作要提交东西必须先由用户确认，不碰密码和验证码。见 `docs/spikes/dedicated-browser.md`。
- **外部插件**：只在沙箱里运行：不给同源的 iframe，从软件自己的协议加载，不能联网；数据只通过 `plugin_call` 拿，只看得到普通内容；权限按 manifest 申请、用户启用时同意；不能删除，不能改隐私层级和设置。见 `docs/spikes/plugin-sandbox.md`。
- **AI 账号**：软件不提供 Claude 登录，不收集任何人的登录凭据，不修改 Claude Code。AI 只通过 `dem-ai-provider` 调用。
- **界面文字**：放语言表，不写死在代码里，中英文都要有。颜色用主题令牌。文案规范见 `docs/05-design.md` 第 14 节。

新增的登记机制、面板、命令和主题，要同步写进 `docs/extending/` 和 `skills/`，并带一个能跑的例子。
