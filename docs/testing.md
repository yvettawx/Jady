# 测试约定

本文是项目的测试约定（P0-30）。新写的 crate 和开发工具都按这里做；要改约定，先提出来讨论。

## 1. 测试放在哪里

| 种类 | 位置 | 说明 |
| --- | --- | --- |
| 单元测试 | 和代码同一个文件里的 `#[cfg(test)] mod tests` | 测内部函数和边界情况 |
| 集成测试 | `crates/<crate>/tests/<主题>.rs` | 只用 crate 的公开接口；开发工具的测试放在 `crates/dem-devtools/tests/<工具模块名>.rs` |
| 随机化测试 | 和它测的代码放在一起（单元或集成都可以） | 用 `proptest`，见第 2 节 |
| 共享测试数据 | 仓库根目录的 `testdata/` | `gateway/`（网关场景）、`ai-regress/`（AI 回归场景）、`search-eval/`（搜索评测集），以后还有迁移样本库；`testdata/generated/` 是生成物，不提交 |
| 共享测试辅助 | `dem-testkit` | 按种子确定性生成数据（P0-34）；只能作为测试依赖或开发工具的依赖，不进正式版本 |

几条细则：

- 集成测试文件第一行写 `#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]`。单元测试已由 `clippy.toml` 放开，不用再写。
- 会安装全局状态的测试（例如 `dem-diag` 初始化全局日志订阅者）单独占一个测试文件，因为同一个测试程序里只能装一次。
- 测试不访问网络，不依赖本机上已有的文件，不写仓库目录以外、临时目录以外的地方。
- 代码和注释用英文；测试名写成一句说明行为的话，例如 `hidden_items_are_indistinguishable_from_missing_ones`。

## 2. 随机化测试（proptest）

- 依赖：工作区的 `proptest`，作为开发依赖引入。
- 用例数：默认配置是每个属性 256 个用例，并且会读取环境变量 `PROPTEST_CASES`。开销大的属性（要建库、要做密钥推导）用 `#![proptest_config(ProptestConfig::with_cases(n))]` 固定一个较小的 n。注意：这样写死的 n 不受 `PROPTEST_CASES` 影响。
- 日常和 CI：用上面的默认值或固定值。CI 目前没有设置 `PROPTEST_CASES`。
- 深度运行（手动，例如改了格式或加密之后）：`PROPTEST_CASES=5000 cargo test -p <crate>`，只对没写死用例数的属性生效。
- 失败时 proptest 会把缩小后的反例写进 `proptest-regressions/` 目录。**这些文件要提交**，以后每次运行都会先重放它们。
- 已有的模板可以照抄：加解密往返（`dem-crypto` 的 `envelope.rs`、`stream.rs`），格式读写（`dem-store/tests/library.rs` 的随机编辑序列），JSON 往返（`dem-devtools/tests/convert.rs`）。CRDT 合并的模板在 P1 写进 `dem-store`。

## 3. 固定种子和临时库

- 生成数据一律用 `dem_testkit::generate(&GenConfig::new(seed, n))`，测试里写死种子。同一个种子两次生成的结果完全相同，失败可以复现。
- 需要库文件的测试，在 `tempfile::tempdir()` 里新建：`Library::create(&dir.path().join("v"), PW, KdfParams::INSECURE_FOR_TESTS)`。临时目录在测试结束时自动删除。
- **`KdfParams::INSECURE_FOR_TESTS` 只能出现在测试和开发工具里**（它是最便宜的有效参数，只为了让测试快）。正式代码只能用 `KdfParams::DEFAULT` 或格式规范定下的参数。
- 测试里的密码、恢复码都是写死的假值，不能是真的。

## 4. 金丝雀

“金丝雀”是一段独一无二的字符串，放在不该泄露的地方，然后在所有输出里查找它。能查到就是泄露。用法：

- **隐私**：`dem-dev gateway-sim` 每次运行生成新的随机金丝雀（如 `CANARY_PRIVATE_<随机十六进制>`），放进私密、机密、敏感条目的标题、正文和标签。每一次工具调用的返回都要查：私密和机密的金丝雀、编号永远不能出现；敏感的只在授权会话里出现。
- **日志**：把 `CANARY-BODY`、`CANARY-SECRET` 之类的字符串故意写进日志语句，再读日志文件，确认找不到（`dem-diag/tests/init.rs`）。
- **AI 回归**：场景文件里的条目带固定的金丝雀，整份对话记录里都查。
- **必须有对照**：只证明“找不到”不够，还要证明“该出现时找得到”。例如授权会话读敏感条目时必须看到敏感金丝雀；`gateway-sim` 自带一个故意泄露的假网关（`--target leaky`），它必须被查出来。没有对照的金丝雀测试，可能只是金丝雀没放对。
- 隐私和日志相关的改动，必须带对应的金丝雀测试（CLAUDE.md 硬性规则）。

## 5. 哪些在 CI 里跑，哪些只手动跑

| 内容 | 在哪里跑 | 说明 |
| --- | --- | --- |
| 格式检查、clippy、全部单元和集成测试、分层检查、`cargo deny`、前端检查 | CI（Windows）和本机 `cargo xtask ci`（macOS） | 每次推送都跑 |
| 网关调试台 `gateway-sim`、搜索评测的假实现、损坏演练、格式校验、转换往返 | 同上，作为普通测试 | 不花额度，几秒内完成 |
| AI 回归 `ai-regress` | **只手动** | 会用订阅额度。没有 `--i-understand-this-uses-quota` 时拒绝运行；检测到 `CI` 或 `GITHUB_ACTIONS` 环境变量时总是拒绝。测试只覆盖解析、启动参数、检查逻辑和拒绝路径，从不启动 Claude Code |
| 性能基准 `bench` | 只手动，release 模式 | 结果写进 `docs/spikes/06-benchmark.md` |
| `spikes/` 下的实验 | 只手动 | 不在工作区里，CI 不编译 |

## 6. 怎么运行

```sh
cargo xtask ci                       # CI 跑的全部检查（本机 macOS）
cargo xtask ci --no-frontend         # 跳过前端
cargo test -p dem-store              # 一个 crate
cargo test -p dem-devtools --test gateway_sim   # 一个集成测试文件
PROPTEST_CASES=5000 cargo test -p dem-crypto    # 深度随机化测试

# 开发工具
cargo run -p dem-devtools -- gateway-sim                  # 隐私矩阵 + testdata/gateway 下的场景
cargo run -p dem-devtools -- gateway-sim --target leaky   # 对照：必须失败
cargo run -p dem-devtools -- search-eval                  # 搜索评测（P0 是假实现）
cargo run -p dem-devtools -- ai-regress --dry-run         # 只打印计划和完整启动命令
cargo run -p dem-devtools -- ai-regress --mcp-config <模板> --i-understand-this-uses-quota   # 真跑，花额度
cargo run --release -p dem-devtools -- bench
```

## 7. 三个测试框架的格式

### `testdata/gateway/*.json`（P0-32）

一个场景是一个会话（`authorized` 表示是否授权读敏感内容）和一串工具调用。每一步写 `call`（工具名和参数）和 `expect`：`ok`、`ids`（返回里全部 `id` 的集合）、`contains` / `not_contains`、`same_as`（必须和另一个调用的返回完全相同，用来验证“不可见等于不存在”）、`proposal_queued`、`protected_links`。字符串里可以用 `{canary.private}` 等占位符。拼错的键直接报错。

无论场景写了什么，每一步都自动检查：没有泄露（金丝雀和隐藏条目的编号）、数据没有被改动。另外运行器自动生成“每个工具 × 每个隐私层级 × 授权与否”的矩阵。P3 把真正的 `dem-ai-gateway` 接到 `GatewayUnderTest` 接口上，用同一套场景测。

### `testdata/ai-regress/*.json`（P0-33）

`name`、`session`（`normal` 或 `sensitive`）、`prompt`、`setup.items`（网关要提供的数据，条目可以带 `canary`）、`checks`（`no_canary_leak`、`proposal_schema_valid`、`expected_tool_calls`、`must_mention`、`harvest`）、`max_turns`。“本次收获”检查（`harvest`）现在只占位，报告里显示为跳过，P3 实现。

`--mcp-config` 是一个 MCP 配置模板，里面的 `{setup}` 会被替换成该场景的 `setup.json` 路径。`setup.json` 的内容是 `session`、`authorized`（敏感会话为 true，网关据此决定敏感条目是否可见）和 `items`。P0 需要手动提供一个能读这份数据的网关；P3 由运行器自己在进程内启动网关。报告写在临时目录（或 `--out`）下的 `report.json`，每个场景的完整对话记录也在那里。

### `testdata/search-eval/*.json`（P0-37）

`docs`（编号、语言、标题、正文）、`queries`（编号、类别、查询、期望结果的完整集合、备注）、`highlights`（查询、文档、字段、带标记的期望高亮）、`k`。种子来自 P0-11 的样例。“命中”指前 k 个结果正好等于期望集合；报告按类别给出命中率和 recall@k，并列出每个未命中查询缺了哪些、多了哪些。`--min-hit-rate` 可以把命中率变成退出码。P1 接入 `dem-index` 后正式运行。

## 端到端测试

`pnpm run probe:app`（在 `apps/desktop`）把真实界面和真实核心连起来走完全程：Tauri 的模拟运行环境挂上真实命令（`src-tauri/src/e2e.rs`，只在 `e2e` 特性下编译，不进发布版），Playwright 驱动浏览器。macOS 的 WKWebView 没有 WebDriver，这是能自动化的最接近真实的方式。

- `BUILT=1` 用打包后的文件，在正式的内容安全策略下跑。改了策略或依赖 WASM 的东西一定要跑。先 `pnpm run build`。
- `ENGINE=chromium` 换引擎，默认 WebKit。
- `SHOTS=<目录>` 存截图。

它覆盖不到的：系统对话框、钥匙串、全局快捷键、系统通知、打印、多窗口事件。这些要在真实窗口里手动试。

`probe:p2`、`probe:p3` 用同一套连接（`probe/harness.mjs`），已经建好库，直接从要测的地方开始。`probe:p3` 背后是不用额度的假 AI，所有工具调用都走真实网关。

`probe:plugins` 装上 `probe/fixtures/plugins/escape-check`，这个插件把能想到的出路都试一遍（读父页面、拿 Tauri 的调用通道、联网、加载外部图片、开新窗口、越权写入），探针逐条确认都关着。插件文件由连接程序按同样的规则和内容安全策略提供，代替 `jadyplugin:` 协议。它覆盖不到的：真实窗口里的协议和导航拦截，要在真实窗口里装一次例子插件看。

`node probe/real-ai.mjs` 用真实的 Claude Code，会用掉一点额度（用 haiku，一次不到 0.05 美元），所以手动跑：改了网关、提供者或 Claude Code 升级后跑一次。
