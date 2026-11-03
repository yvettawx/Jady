---
name: dem-ai-provider
description: 给 Jady 接入新的 AI 提供者，或者接 DeepSeek、Ollama 这类兼容 OpenAI 的服务。当用户想换一种 AI 接入方式时用。
---

# 接入新的 AI

先读 `docs/extending/ai-provider.md` 和 `CLAUDE.md` 的硬性规则。接口在 `crates/dem-ai-provider/src/lib.rs`，这是唯一可信的来源。

## 先判断要不要写代码

对方兼容 OpenAI 的 Chat Completions 接口（DeepSeek、Ollama、LM Studio、vLLM 等）就不用写：让用户在设置 › AI 里选“OpenAI 兼容接口”，填地址（比如 `http://localhost:11434/v1`）和模型名，要 key 的再填 key。告诉用户这种方式不能上网。

## 要写代码时

1. 先跑通例子，看清一个提供者长什么样：

   ```bash
   cargo run -p dem-ai-provider --example my_provider
   ```

   它在 `crates/dem-ai-provider/examples/my_provider.rs`，里面的 `Echo` 是最小的完整实现，跑在一个假网关上。
2. 在 `crates/dem-ai-provider/src/` 加一个文件，实现 `AiProvider` 和 `AiSessionHandle`。照着最像的那个改：
   - 自己带工具的 agent 程序，一个会话一个长驻进程：`claude_code.rs`；
   - 每轮一个进程：`codex.rs`（第二轮起用 `config.mcp.reissue` 拿新令牌）；
   - HTTP 接口、工具循环在本进程：`openai_compat.rs` 或 `api_key.rs`。
3. 选一条拿数据的路：工具在本进程调用（`config.tools`），或者 MCP（`config.mcp`）。
4. 在 `apps/desktop/src-tauri/src/ai.rs` 的 `register_builtin` 里登记；要 key 的在 `key_account` 里加一个钥匙串条目名；界面文字加进 `src/i18n/zh-CN.json` 和 `en.json` 的 `settings.ai.provider.<编号>`、`settings.ai.connect.<编号>.hint`，编号加进 `AiSettingsSection.tsx` 的 `BUILTIN`。
5. 写测试，至少覆盖：`config.web` 为假时请求里没有任何上网工具；工具报错时错误传回去了；key 不出现在错误和日志里（照 `openai_compat.rs` 的 `the_key_stays_out_of_errors_and_logs`）。会启动别的程序的，再测它出现不该有的工具时会被结束（照 `codex.rs` 的测试，用一个假的脚本代替真程序）。
6. 验证：

   ```bash
   cargo test -p dem-ai-provider
   cargo test -p dem-core ai_tools
   cargo test -p dem-desktop ai::tests
   cd apps/desktop && pnpm run probe:p3
   ```

   有真实账号时再跑 `PROBE_PROVIDER=<编号> node probe/real-ai.mjs`，它放金丝雀，确认私密和机密不出现。

## 不能做的

- 不把任何 AI 账号登录做进软件，不收集凭据，不代别人付费。用户自己登录自己的账号。
- 不给 AI 工具清单以外的能力：不能读文件，不能执行命令。别的程序关不掉某个能力，就不接，把原因告诉用户，不要放松规则。
- 不改别的 CLI，不改它的登录目录（比如 `CODEX_HOME`），不读它的登录文件。
- 不改 `crates/dem-core/src/ai_view.rs` 和 `ai_tools.rs` 的可见性规则。要改就停下来问用户。
- 不记录消息内容。
- API key 只进系统钥匙串。

用户没明确要求时，不要主动接入别的 AI。
