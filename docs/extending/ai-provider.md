# 接入新的 AI

AI 提供者是 `crates/dem-ai-provider` 里的一个接口。内置四个实现：Claude Code、Codex、Anthropic API key、OpenAI 兼容接口，新的按同样方式加。其他代码只认接口，不知道背后是谁。

**先看用不用写代码。** 只要对方兼容 OpenAI 的 Chat Completions（DeepSeek、Ollama、LM Studio、vLLM 和大多数模型服务都是），在设置 › AI 里选“OpenAI 兼容接口”，填地址和模型就行。要写代码的是 Codex 这种自己带工具的 agent 程序，或者接口完全不同的服务。

## 接口

```rust
pub trait AiProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn status(&self) -> ProviderStatus;
    fn start(&self, config: SessionConfig) -> Result<Box<dyn AiSessionHandle>>;
    fn self_check(&self, config: SessionConfig) -> Option<Result<()>> { None }
    fn check_model(&self) -> Option<&'static str> { None }
}

pub trait AiSessionHandle: Send {
    fn send(&mut self, message: &str, on: &mut dyn FnMut(AiEvent)) -> Result<()>;
    fn stopper(&self) -> Arc<dyn Fn() + Send + Sync>;
}
```

`send` 发一条消息，边生成边用 `on` 报告 `AiEvent`：文字、正在用的工具名、用量、提前停下的原因。

## 从哪里拿数据

`SessionConfig` 给两条路，选一条：

- **在本进程调工具**：`config.tools` 的 `tools()` 给工具定义，`call(name, args)` 执行。API key 和 OpenAI 兼容接口走这条，见 `src/api_key.rs`、`src/openai_compat.rs`。
- **MCP**：`config.mcp` 给本机套接字和一次性令牌。别的程序用 `--dem-gw-shim` 接上。Claude Code 和 Codex 走这条，见 `src/claude_code.rs`、`src/codex.rs`。一个会话只连一次的用 `config.mcp.token`；像 Codex 那样每轮一个新进程的，第二轮起调 `config.mcp.reissue` 拿新的一次性令牌。

**可以运行的例子：** `crates/dem-ai-provider/examples/my_provider.rs`，一个最小的完整提供者，加上内置的兼容接口，跑在一个假网关上：

```bash
cargo run -p dem-ai-provider --example my_provider
# 有本地模型的话，换成真的：
cargo run -p dem-ai-provider --example my_provider -- http://localhost:11434/v1 qwen3
```

复制里面的 `Echo` 开始最快。要在软件里连真实网关测，用 `apps/desktop/src-tauri/src/e2e.rs` 里的 `Fake`，`pnpm run probe:p3` 就是用它测的。

## 登记

```rust
runtime.registry.register(Arc::new(MyProvider::default()));
```

在 `apps/desktop/src-tauri/src/ai.rs` 的 `register_builtin` 里，或者在 `lib.rs` 调完它之后。设置里的“接入方式”会自动多一项，显示提供者的编号；要显示名字和说明，在 `src/i18n/zh-CN.json` 和 `en.json` 里加 `settings.ai.provider.<编号>` 和 `settings.ai.connect.<编号>.hint`，并把编号加进 `AiSettingsSection.tsx` 的 `BUILTIN`。

要 key 的，在 `ai.rs` 的 `key_account` 里给它一个钥匙串条目名，设置里就会出现 key 的输入框。

现在是编译时加入。插件在运行时加入提供者放在 P5。

## 必须做到

这些不是建议。做不到的提供者不能合并：

- 数据只从网关工具来。给 AI 的只有这些工具，不能让它读文件、执行命令。
- `config.web` 是假的时候，不能有任何上网能力。敏感授权会话就靠它。
- 不收集、不保存任何登录凭据。密钥只放系统钥匙串，用 `Core::secret_set`。
- 不写日志记录消息内容。
- 如果会启动别的程序，实现 `self_check`：确认它真的只有该有的工具。程序报不出工具清单的（比如 Codex），在运行中逐条检查它做了什么，出现不该有的就立刻结束进程。
- 错误信息里如果可能带回 key（有的服务会把请求头原样报回来），用 `redact` 去掉。

## 验证

```bash
cargo test -p dem-core ai_tools
cargo run -p dem-devtools -- gateway-sim --target real
cd apps/desktop && pnpm run probe:p3
```

要测真实服务，仿照 `probe/real-ai.mjs`：放几条金丝雀，确认私密和机密从不出现在回答里。

## 现状

软件自带四种：

| 编号 | 是什么 | 拿数据 | 上网 |
| --- | --- | --- | --- |
| `claude-code` | 运行用户自己登录的 Claude Code | MCP | 普通会话有，授权会话没有 |
| `codex` | 运行用户自己登录的 Codex，每轮一个进程 | MCP | 普通会话有，授权会话没有 |
| `api-key` | Anthropic API key | 本进程 | 普通会话有，授权会话没有 |
| `openai-compatible` | 用户填的地址和模型，key 可选 | 本进程 | 没有 |

Codex 的参数和依据见 `docs/spikes/codex.md`。提供者要能以受限方式运行：只给网关工具，授权会话不能上网；`self_check` 用来证明这一点。
