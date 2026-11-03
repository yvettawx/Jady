# 给 AI 加软件自己的工具

库里的内容只能通过 `dem-core` 的受限视图给 AI（`dem_core::ai_tools`）。有些工具不碰库里的内容，比如专用浏览器，它们走网关的另一个口子：`dem_ai_gateway::AppTools`。

```rust
pub trait AppTools: Send + Sync {
    /// 和库的工具同样格式的定义：name、description、input_schema。
    fn tools(&self) -> Vec<serde_json::Value>;
    /// 不是自己的工具就返回 None，交给库的工具处理。
    fn call(&self, name: &str, args: &serde_json::Value) -> Option<Result<String, String>>;
}
```

一个会话用哪些，在 `apps/desktop/src-tauri/src/ai.rs` 的 `ai_start` 里决定，传给 `GatewayServer::start_with` 和 `make_config`。Claude Code 和 API key 两种接入都会拿到同一份工具。

能跑的例子：`crates/dem-ai-gateway/src/mcp.rs` 测试里的 `Pages`，运行 `cargo test -p dem-ai-gateway`。真实的例子：`apps/desktop/src-tauri/src/browser.rs` 的 `BrowserTools`。

## 规则

- 这些工具拿不到库里的内容，也不能改设置。要读库就加到 `dem_core::ai_tools`，那里有受限视图。
- 会话能不能用，按会话类型决定。能读敏感内容的授权会话没有上网，所以凡是会把东西送出电脑的工具都不能给它。写一个像 `browser.rs` 里 `gets_browser` 那样的函数，并为它写测试。
- 会对外发东西的操作要先问用户，像浏览器的提交确认那样。
- 插件（界面里的 `ctx`）不能加 AI 工具：AI 能用什么是安全边界，只能在 Rust 里改，并经过审查。
