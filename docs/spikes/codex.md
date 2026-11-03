# 技术验证：Codex CLI 作为 AI 提供者

- 日期：2026-11-03
- Codex CLI：npm 上的最新版本是 **0.166.0**。本机没有装 Codex，这次装它的请求也被拦下了，所以**下面的结论来自官方文档和源码，没有实测**。
- 读过的资料：官方配置参考、无交互模式和命令参考（developers.openai.com/codex 下的页面，现已跳转到 learn.chatgpt.com/docs）；openai/codex 主分支的 `codex-rs/core/src/tools/spec_plan.rs`、`codex-rs/core/src/mcp_tool_call.rs`、`codex-rs/features/src/lib.rs`、`codex-rs/exec/src/cli.rs`、`codex-rs/exec/src/lib.rs`；GitHub issue #24135、讨论 #8338；Sign in with ChatGPT 的开发者文档。OpenAI 的服务条款页和帮助中心这次打不开（HTTP 403），没读到。
- 代码：`crates/dem-ai-provider/src/codex.rs`。

## 要回答的问题

1. 能不能只给它网关工具和上网，禁掉执行命令和读写本地文件？
2. 授权读取敏感内容的会话里，能不能把上网也关掉？
3. 网关怎么接（MCP 服务器怎么配），`codex exec` 里 MCP 调用会不会被拦？
4. 怎么挡住用户自己的 Codex 配置，又不丢登录？
5. 会不会把对话明文写到库外？
6. OpenAI 允不允许别的程序启动用户自己的 Codex、用用户的订阅？

## 结论

| 要求 | 做法 | 依据 | 实测 |
| --- | --- | --- | --- |
| 不能执行命令 | `features.shell_tool=false` | 源码 `add_shell_tools` 一开头判断这个开关，关了就直接返回，两个命令工具（一次性的和 unified exec）都不登记。文档说 unified exec 不能单独关，但它在这个开关里面 | 否 |
| 不能读本地文件 | 同上；另关 `features.view_image`（它能读本机图片）；沙盒 `read-only` | 源码里没有单独的读文件、列目录工具，读文件只能靠命令 | 否 |
| 不能写本地文件 | 沙盒 `read-only`，`approval_policy="never"` | `apply_patch` 由模型目录决定，用户关不掉；只读沙盒加不批准，写入会被拒 | 否 |
| 没有别的工具来源 | `--ignore-user-config`，关 `features.apps`（ChatGPT 连接器）、`multi_agent`、`image_generation`、`memories`、`hooks`，关自带技能 | 配置参考 | 否 |
| 只有网关工具 | MCP 服务器 `dem` 设 `enabled_tools` 为网关工具清单、`required=true` | 配置参考；`required` 的服务器起不来时 `codex exec` 直接退出 | 否 |
| MCP 调用不被取消 | 每个网关工具 `approval_mode="approve"`，再加服务器级 `default_tools_approval_mode="approve"` | issue #24135：`exec` 里没人批准，MCP 调用默认被取消；有人在 0.154.0 用逐个工具的 `approve` 跑通。源码里 `Approve` 不需要批准 | 否 |
| 普通会话能上网 | `web_search="live"` | 配置参考。搜索在 OpenAI 那边执行，不从本机发请求，所以不会连到本机和局域网 | 否 |
| 授权会话不能上网 | `web_search="disabled"` | 配置参考：“disabled 会去掉这个工具” | 否 |
| 不写对话记录 | `--ephemeral`，`history.persistence="none"`，日志和状态库指到会话私有目录 | 命令参考 | 否 |

结论：**规则上能做到，接了**。但这些都是读文档和源码得出的，要在真机上跑一遍才算数。为了不靠“文档说的对”，又加了两道：

1. **运行中逐条检查**。`codex exec --json` 每一步都打一行事件。只认文字、思考、计划、网关 `dem` 的调用和允许时的搜索；出现执行命令、改文件、别的 MCP 服务器、授权会话里的搜索，或者任何不认识的事件，立刻结束进程，这轮报错。命令开始的事件在命令真正跑之前就打出来，所以多半来得及；即使来不及，结果也到不了模型手里。
2. **版本变化后自检**（M6）。和 Claude Code 一样，Codex 版本一变，先在一个空的网关会话里跑一轮：让它调一次网关的 `context`，并且“如果你有能执行命令或读文件的工具，就跑一下 `pwd`”。没调到网关，或者出现任何上面那些事件，自检失败，AI 功能停用。

## 怎么启动

每轮一个进程：

```
codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only
  -c approval_policy="never"
  -c features.shell_tool=false  -c features.view_image=false  -c features.apps=false
  -c features.multi_agent=false -c features.image_generation=false
  -c features.memories=false    -c features.hooks=false
  -c skills.bundled.enabled=false -c skills.include_instructions=false
  -c history.persistence="none" -c log_dir="<会话目录>/codex" -c sqlite_home="<会话目录>/codex"
  -c model_instructions_file="<会话目录>/codex/instructions.md"
  -c web_search="live"          （授权会话是 "disabled"）
  -c mcp_servers.dem.command="<软件自己>" -c mcp_servers.dem.args=["--dem-gw-shim"]
  -c mcp_servers.dem.env_vars=["DEM_GW_SOCKET","DEM_GW_TOKEN"]
  -c mcp_servers.dem.required=true
  -c mcp_servers.dem.enabled_tools=[网关工具]
  -c mcp_servers.dem.default_tools_approval_mode="approve"
  -c mcp_servers.dem.tools.<每个网关工具>.approval_mode="approve"
  [--model <模型>]
  -        （消息从标准输入进来）
```

- **系统提示**写进会话私有目录里的文件（0600），用 `model_instructions_file` 交给它，不放在命令行上。这会替换 Codex 自带的“写代码”说明。
- **令牌**放在 Codex 进程的环境变量里，用 `env_vars` 传给转接程序，不出现在命令行上（命令行别的用户用 `ps` 能看到）。
- **工作目录**是会话私有目录下的空文件夹，没有项目里的 `AGENTS.md` 和 `.codex/`。

## 多轮对话

`codex exec` 答完一轮就退出。要续接只有 `codex exec resume`，它需要把整段对话（包括网关返回）明文存在 `~/.codex/sessions`，和 M6 的规定冲突。所以：

- 每轮一个新进程，带 `--ephemeral`，什么都不落盘；
- 之前的对话（只有双方说的话，不含工具结果）作为这一轮的输入，从标准输入送进去；
- 网关的令牌是一次性的，每个新进程要重连，所以网关加了 `issuer()`：每次给一个新的一次性令牌，同时作废还没用的旧令牌。仍然是一个令牌只能连一次、只能连这个会话。

代价是每轮都重新带上之前的对话，上下文越长越费额度；之前的工具结果不在，要用的话模型会再调一次。也考虑过 `codex app-server` 和 `codex mcp-server` 这两种长驻方式，协议更复杂，文档里也没写清楚能不能不落盘，先不用。

## 配置隔离和登录

- `--ignore-user-config` 不读 `~/.codex/config.toml`，文档写明“登录仍然用 `CODEX_HOME`”。所以用户的 MCP 服务器、插件、模型设置都不加载，登录照常。
- **不改 `CODEX_HOME`**。改到空目录的话，用文件保存登录的用户要重新登录，等于软件在替 Codex 管登录，这正是规则不允许的。
- 软件只调 `codex login status` 看退出码判断有没有登录，不读输出，不碰 `auth.json` 和钥匙串。
- 设置里“不加载我自己的配置”那个开关只管 Claude Code。Codex 总是隔离。
- 没确认的：`~/.codex/AGENTS.md`（全局说明）是不是也被 `--ignore-user-config` 挡住。挡不住的话，只是用户自己写的说明会带进去，不影响工具和数据，但要在实测时看一下。

## 条款

**没找到明确的说法。**

- OpenAI 没有一份像 Anthropic《法律与合规》那样直接回答“别的程序能不能启动用户自己的 Codex CLI”的官方页面。
- 官方 Sign in with ChatGPT 文档说它是给“开源和本地运行的应用”用 ChatGPT 额度的；付费或托管的应用要先填申请表。那套文档讲的是应用自己做登录、自己拿令牌，Jady 不做登录，也不读 Codex 的令牌。
- 二手报道（AICoder，引用 OpenAI 的 Codex 负责人在 X 上的发言）说：第三方客户端用 Sign in with ChatGPT 接 Codex 不是认可的用法，纯开源客户端和已有合作的伙伴除外。同样针对的是自己做登录的客户端。
- GitHub 讨论 #8338 里 OpenAI 的工程师说条款和许可“相当宽松”，OpenCode 这类开源项目在做类似的事，但他明确说自己不是律师。

我的判断：Jady 开源、本地运行、只启动用户自己装的未修改的 Codex、不经手登录，落在最宽松的那一类里，风险不大，但**没有官方明确允许**。用户也可以在 Codex 里用自己的 OpenAI API key 登录（`codex login --with-api-key`），那就按 API 条款计费，没有疑问。开源发布前要再查一次，特别是 OpenAI 的服务条款和 Sign in with ChatGPT 条款（这次 403 没读到）。

## 还要实测的

装好 Codex 并登录后，在一个空的库上跑：

```bash
cd apps/desktop && PROBE_PROVIDER=codex node probe/real-ai.mjs
```

它会放金丝雀，确认：自检通过；能调网关；私密和机密不出现；改动变成提议；让它跑命令和读 `/etc/hosts` 时没有命令工具；授权会话读得到敏感、上不了网。另外手动看三件事：

1. `codex features list`（带同样的 `-c`）里 `shell_tool`、`view_image`、`apps` 是关的；
2. 跑完后 `~/.codex/sessions` 和 `~/.codex/history.jsonl` 没有新内容；
3. 某个 `-c` 写错时（比如键名在新版本里改了），Codex 是报错退出还是只警告。报错退出的话自检会失败，这是对的；只警告的话，要靠运行中检查兜底。
