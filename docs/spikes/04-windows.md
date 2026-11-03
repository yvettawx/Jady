# 技术验证 04：Windows 差异（P0-13）

- 日期：2026-10-17 至 2026-10-18
- 已测机器：Apple M1，macOS 26.6.2（25G83），APFS（大小写不敏感，默认卷）；WKWebView 21624.5.1.11.3
- Windows：2026-10-19 在 Windows 11 专业版 25H2（26200.9711，i5-13400F，NTFS，WebView2 155.0.4283.62）上由 Claude Code 按清单执行，结果见下方“Windows 实测”和 `spikes/platform/results/windows/`
- Rust 1.99.1（只用标准库，外加 tempfile 3.27.0 建临时目录）；Tauri 2.12.4（wry 0.57.0，Windows 上 webview2-com 0.39.1）；ProseMirror：prosemirror-view 1.42.6、prosemirror-state 1.4.4、prosemirror-model 1.25.12、prosemirror-schema-basic 1.2.5、prosemirror-example-setup 1.2.3
- 字体：Noto Serif Tangut 2.170（不带 hinting 的 OTF，1.9 MB，SIL OFL 1.1）。Noto 没有 “Noto Sans Tangut”，西夏文只有衬线体
- 代码与复现：`spikes/platform/`（README 有命令）；原始输出：`spikes/platform/results/`

## 要回答的问题

1. 渲染：同一个页面在 WebView2（Windows）和 WebKit（macOS）下，字体（含西夏文）、滚动条、Canvas/WebGL、CSS 特性、**中文输入法在 ProseMirror 里的输入**有什么差异。
2. 文件：路径长度、大小写不敏感、原子替换（目标文件被别的程序占用时）、同一个库被两个进程打开时的锁。
3. 安装：未签名安装包的 SmartScreen 提示；WebView2 运行时缺失时安装程序怎么办。

## 做法

- **文件**：`fsprobe` 只用 Rust 标准库（`dem-store` 将来也只用它），两个平台跑同一套 `cargo test`（21 个测试）：
  - 原子替换 = 同目录写临时文件 → `sync_all` → `rename` 覆盖 →（可选）刷目录。测试包括：无残留、同进程持有旧句柄、另一个进程持有句柄（标准库默认共享方式 / 不共享删除 / 完全独占）、2 个读线程并发读 1500 次替换时有没有读到半截内容或打不开、写到一半进程崩溃（`abort`）后目标完好且临时文件可清理。
  - 名字：大小写和 Unicode 规范化（NFC/NFD）是否视为同一文件、单个文件名上限、绝对路径上限、Windows 保留名。
  - 锁：`std::fs::File::try_lock`（Rust 1.89 起稳定；Unix 上是 `flock`，Windows 上是 `LockFileEx`）。另一个进程、同进程第二个句柄、持锁进程被杀后、遗留锁文件。
  - `fsprobe report` 生成完整报告和写入延迟；`fsprobe stress --dir` 在有杀毒/索引/同步的目录里做替换压力测试。
- **渲染**：探测程序的页面自动检测并把结果写进结果表：字体（用 Canvas 画字比较像素，判断是不是“豆腐块”）、滚动条占用宽度、Canvas 2D 读回和热度图负载、WebGL2 渲染器和绘制读回、19 项 CSS 特性、一批 Web API；输入法部分由人打字后点“检查”，同时记录 composition 事件和 keyCode 229 次数。
- **安装**：查 Tauri、Apple、微软的官方文档；macOS 上用 `codesign`、`spctl`、`syspolicy_check` 实测。

## 数据

### 文件（macOS 实测；Windows 待测）

`cargo test --release -p fsprobe`：21 个测试全部通过（2026-10-18 04:30 复核一次，另在打包后的压缩包里解压重跑一次，均通过）。同一套测试和两个辅助程序已在 Mac 上对 Windows 目标做过类型检查（`cargo check --target x86_64-pc-windows-msvc`），能编译。主要数据（`results/macos-fsprobe-report.md`）：

| 项目 | macOS（APFS） | Windows（NTFS）预期，待测 |
| --- | --- | --- |
| `Abc` / `abc` | 同一文件，保留原拼写 | 同一文件 |
| `Ä`/`ä`、`Σ`/`σ` | 同一文件 | 同一文件 |
| `straße` / `STRASSE` | **同一文件**（APFS 做完整大小写折叠） | 预期两个文件（NTFS 只做简单大写映射） |
| `İ` / `i` | 两个文件 | 待测 |
| NFC `é` / NFD `e+◌́` | **同一文件**（APFS 不区分规范化形式） | 预期**两个文件**（NTFS 不做规范化），测试里已写成断言 |
| 只改大小写的重命名 | 成功，显示新拼写 | 待测 |
| 单个文件名上限 | 255 个 UTF-16 单位（`a`、`中` 255 个；西夏文 127 个 = 254 单位） | 预期 255 个 UTF-16 单位 |
| 绝对路径上限 | 约 1024 字节（第 1049 个字符时 ENAMETOOLONG） | 传统 260（MAX_PATH）；Rust 标准库对长绝对路径自动加 `\\?\` 前缀，测试断言能超过 300 |
| `CON`、`aux.dexm`、`a:b`、`a?b`、结尾点或空格 | 都能建 | 预期报错或被改名 |
| 原子替换，另一个进程持有目标（标准库默认共享方式） | 成功，旧句柄继续读到旧内容 | 待测 |
| 另一个进程不共享删除 / 完全独占 | 成功（Unix 没有共享模式） | 可能失败（共享冲突，错误码 5/32/33）；测试要求失败时目标完好、临时文件已清理、退避重试能成功 |
| 2 个读线程 × 1500 次替换 | 读到半截内容 0 次，打不开 0 次（两次运行，每个测试读成功 2.2～2.6 万次） | 半截内容必须为 0（硬断言）；打不开的次数记录下来 |
| 写临时文件后崩溃 / 写到一半崩溃 | 目标完好，留下 1 个临时文件，可按标记清理 | 待测 |
| 刷目录（`sync_all` 目录句柄） | 成功 | 待测（需要 `FILE_FLAG_BACKUP_SEMANTICS` 加写权限） |
| 锁：另一个进程打开同一个库 | 被拒绝（退出码 3） | 待测 |
| 锁：同进程第二次打开 | 被拒绝 | 待测 |
| 锁：持锁进程被杀 | 约 0.1 毫秒内即可重新取得 | 待测 |
| 遗留的锁文件 | 不影响（只有活着的句柄才算持锁） | 待测 |

写入延迟（`fsprobe report`，每档 200 次）：

| 大小 | 不刷盘 | 刷文件（`sync_all`） | 刷文件 + 刷目录 |
| --- | --- | --- | --- |
| 4 KiB | 中位 0.51 ms，95% 0.56 ms | 中位 6.1 ms，95% 8.3 ms | 中位 12.3 ms，95% 18.6 ms |
| 256 KiB | 中位 0.36 ms，95% 0.77 ms | 中位 6.5 ms，95% 10.0 ms | 中位 12.8 ms，95% 19.5 ms |

macOS 上 Rust 的 `sync_all` 用的是 `F_FULLFSYNC`（真正落盘），所以每次约 6 毫秒；文件加目录两次刷盘约 12 毫秒，95% 接近 19 毫秒，已经贴近“保存一次修改 ≤ 20 毫秒”的指标。

压力测试放在 `~/Documents`（本机开启了 iCloud“桌面与文稿”同步的迹象：`~/Library/Mobile Documents/com~apple~CloudDocs/Documents` 指向它）：3000 次替换（每次刷文件）、2 个读线程，读成功 29 万次，半截内容 0，打不开 0，写失败 0，重试 0；写入中位 6.4 ms，99% 18.1 ms，最大 92.8 ms。

### 渲染（macOS WKWebView 实测；WebView2 待测）

无人值守运行的完整结果：`results/macos-app-unattended.md`（72 行）。

| 项目 | macOS WebKit |
| --- | --- |
| 西夏文，随包字体 | 加载 0～76 ms（多次运行，首次最慢），4 个字形各不相同（正常显示） |
| 西夏文，只用系统字体 | 豆腐块或空白：**系统没有西夏文字体，必须随软件带字体** |
| CJK 基本区、扩展 B 区（系统字体） | 正常 |
| 检测到的中文字体 | PingFang SC、Hiragino Sans GB、Songti SC，另有 Microsoft JhengHei、SimSun：后两个来自本机装的 Microsoft Office（`Word.app/Contents/Resources/DFonts`），不是 macOS 自带，不能当作 Mac 上一定有 |
| 滚动条 | 默认是浮层滚动条（占 0 px）；`::-webkit-scrollbar` 设宽度后变成常驻 8 px；`scrollbar-width`、`scrollbar-gutter`、`scrollbar-color` 都支持 |
| Canvas 2D | 读回正确；热度图负载（371 个圆角格子）每帧 0.5～0.9 ms（两次运行） |
| WebGL2 | 可用，渲染器 Apple GPU，最大纹理 16384；绘制 + `readPixels` **锁屏时会卡死**（GPU 读回不返回），无人值守时跳过，待人工运行 |
| WebGPU | 有，能拿到适配器 |
| CSS | 容器查询、`:has()`、嵌套、`color-mix()`、`oklch()`、`text-wrap: balance`、subgrid、`backdrop-filter`、`@property`、锚点定位、`field-sizing`、滚动驱动动画、`dvh`、`light-dark()`、视图过渡、`content-visibility`、`text-autospace`、`@layer` 都支持；**`text-spacing-trim` 不支持** |
| Web API | `crypto.subtle`、IndexedDB、WebAssembly、Worker、剪贴板写入、`Intl.Segmenter`（中文分词示例：机械 / 降 / 神 / 计划 / 是 / 一个 / 个人 / 项目）、`getTargetRanges`、视图过渡、Popover、OffscreenCanvas 可用；**EditContext 不可用**；SharedArrayBuffer 不可用（页面未跨源隔离） |
| 中文输入法（ProseMirror / contenteditable / textarea） | 2026-10-18 你亲自用拼音输入：三个框文字一致，无重复字、无丢字，选字开始/结束各 2 次 |

### 安装（官方文档 + macOS 实测）

- **WebView2 安装方式**（Tauri `bundle.windows.webviewInstallMode`，tauri-utils 2.10.2 源码与官方文档一致）：

  | 方式 | 需要联网 | 安装包增加 | 说明 |
  | --- | --- | --- | --- |
  | `downloadBootstrapper`（**默认**，`silent` 默认 true） | 是 | 0 | 安装时发现没有 WebView2 才下载引导程序并静默安装 |
  | `embedBootstrapper` | 是 | 约 1.8 MB | 引导程序打进安装包，仍要联网下载运行时 |
  | `offlineInstaller` | 否 | 约 127 MB | 完整离线安装程序 |
  | `fixedRuntime` | 否 | 约 180 MB | 固定版本运行时随软件分发，安全更新要自己跟 |
  | `skip` | — | 0 | 不安装，不推荐 |

  官方文档：Windows 10（2018 年 4 月版及以后）和 Windows 11 已把 WebView2 作为系统组件分发。也就是说在你的台式机上基本**没法真实测到“缺失”**的情况。
- NSIS 默认 `installMode: currentUser`：不需要管理员，装到 `%LOCALAPPDATA%`。
- **SmartScreen**（Tauri 官方签名文档）：未签名的程序经浏览器下载后会出现 SmartScreen 警告，用户可以选择仍然运行；签名后能避免，但 2024 年起 EV 证书也不再“立即获得信誉”，EV 和 OV 一样要慢慢积累。
- **智能应用控制（Smart App Control，微软官方说明）**：开启时会**直接拦截未签名程序，而且不能按单个程序放行**，只能整体关闭。较新的 Windows 更新允许不重装系统就开启它。你的台式机如果开着它，未签名的开发版本根本运行不了。
- macOS 侧的签名结论见 03 号文档：需要 `signingIdentity: "-"`，否则下载后的程序会是“已损坏”状态。

## 结论

| 项目 | 差异 | 影响 | 对策 |
| --- | --- | --- | --- |
| 大小写 | 两个平台默认都不区分大小写，但折叠规则不同（APFS 完整折叠，`ß`=`SS`；NTFS 简单映射） | 用户可见的名字做文件名会在两个平台上得出不同的冲突结果 | **库里的文件名一律用小写十六进制（编号、哈希）加固定扩展名**，不出现用户输入的名字；新建文件一律 `create_new`，冲突时报错而不是覆盖 |
| Unicode 规范化 | APFS 视 NFC/NFD 为同一文件；NTFS 视为两个 | 同上；同步时同一个名字可能变成两个文件 | 同上；任何进入路径、附加认证数据、索引的文本先转 NFC |
| 路径长度 | macOS 约 1024 字节；Windows 传统 260 | 库放在很深的目录里时，别的工具（资源管理器、同步客户端、脚本）可能出问题 | 库内相对路径保持很短（分片目录 2 字符 + 36 字符编号 + `.dexm`，约 50 字符）；软件自己用 Rust 标准库（会加 `\\?\`），在设置里提示不要把库放得太深 |
| 保留名和非法字符 | Windows 不允许 `CON`、`a:b` 等 | 从 macOS 同步过去的文件可能无法创建 | 规范规定库内文件名的字符集只有 `[0-9a-f._-]` |
| 原子替换 | Unix 上替换永远成功；Windows 上目标被不共享删除地打开时可能失败 | 杀毒、索引、备份、同步程序偶尔导致保存失败 | 保存时对共享冲突错误（5/32/33）退避重试（5 ms 起，最长 2 秒），仍失败则报给用户，**临时文件保留到下次打开时清理**；读文件一律用标准库默认共享方式 |
| 刷盘成本 | macOS 每次 `sync_all` 约 6 ms（真正落盘） | 保存一次刷文件加刷目录约 12 ms，95% 接近 20 ms 指标 | 格式规范里定“刷文件 + 刷目录”为默认，同时把增量写入设计成小文件追加，避免一次保存多次刷盘；P0-40 基准再确认 |
| 锁 | macOS 是建议锁（`flock`），Windows 是强制锁（`LockFileEx`，别的进程连读被锁的字节都不行） | 锁文件本身不能放有用的数据 | 用单独的 `.dem.lock` 文件（只属于本机、不同步），文件内容不读；持锁进程死亡时系统自动释放，遗留文件无害 |
| 网络盘和同步盘 | 网络盘未测；OneDrive 目录 3000 次替换零损坏、零残留（Windows 实测） | `flock` 在网络文件系统上可能不可靠 | 规范里写明：库不支持放在网络盘上；云同步目录可以但不推荐（同步由 P4 自己做） |
| 西夏文字体 | 两个平台系统都没有（macOS 已实测） | 不带字体就显示豆腐块 | 随软件带 Noto Serif Tangut（1.9 MB OTF，可再转 WOFF2 缩小），用 `unicode-range` 只在需要时加载 |
| 滚动条 | macOS 默认浮层（0 px），Windows 默认常驻 | 布局宽度不同 | 布局不依赖滚动条宽度；统一用 `scrollbar-gutter: stable` 和 `scrollbar-width: thin` |
| CSS / Web API | WebKit 不支持 `text-spacing-trim`、EditContext；WebView2 上 CSS 测试项全部正常，国旗表情显示成字母（如 “CN”） | 中文标点挤压要自己处理；编辑器不能依赖 EditContext；界面不要用国旗表情 | 编辑器用 ProseMirror 的 contenteditable 路线，两个平台的中文输入法都已实测正常 |
| 安装 | Windows 有 SmartScreen 和智能应用控制；WebView2 基本都已预装。实测：SmartScreen 弹出“Windows 已保护你的电脑”，“更多信息”里有“仍要运行”；不需要管理员，装到 `%LOCALAPPDATA%`；你的台式机智能应用控制为“关” | 未签名版在开启智能应用控制的机器上无法运行 | 安装包用默认 `downloadBootstrapper`（silent）；个人使用阶段不买证书，你的台式机需要确认智能应用控制的状态；以后要分发再考虑 Azure Artifact Signing 或 OV 证书 |

## 对文档和格式的影响

- **格式规范第 2 节（目录与文件命名）**：文件名字符集限定为小写十六进制、`.`、`-`、`_`；按编号哈希分片的目录名用 2 位小写十六进制；规定所有路径相对库根、正斜杠、NFC、小写（与第 1 节问题 1 的建议一致）。
- **格式规范第 8 节（写入）**：原子写入流程定为“同目录临时文件（带固定标记）→ 写入 → 刷文件 → 替换 → 刷目录”；共享冲突时退避重试；打开库时清理带标记的临时文件。
- **格式规范**新增“本机文件”一节：`.dem.lock`（本机、不同步）；库不支持网络盘。
- **03-modules.md M2**：补充 Windows 共享冲突重试和锁文件的说明。
- **02-architecture.md 第 3 节“字体”**：Noto 的西夏文是 Noto Serif Tangut。
- 以上改动需你确认后同步。

## Windows 实测（2026-10-19）

填好的清单：`spikes/platform/results/windows/04-filled.md`；原始输出在同一目录。

| 项目 | 结果 |
| --- | --- |
| 文件测试 | 21 项全部通过。被不共享地打开时替换先报 `os error 5`，重试约 950 毫秒后成功（印证了重试设计）；`DIR-SYNC` 可用；路径最长 623 字符仍可写（长路径策略已开）；NFC 和 NFD 是两个不同文件；进程被杀后锁 278 微秒内释放 |
| 原子替换延迟（4 KiB） | p50 约 1.6～2.4 毫秒，比 macOS 快（macOS 刷盘约 6 毫秒） |
| 压力测试（3000 次替换） | 临时目录、文档、OneDrive 三处都是零损坏、零写入错误、零残留；读者偶尔看到 `NotFound`（替换瞬间），说明读取方也要短暂重试 |
| 两个程序打开同一个库 | 第二个进程读 `.dem.lock` 被拒；记事本仍能打开这个空文件（不影响锁的作用） |
| 渲染 | 字体、滚动条（默认常驻 14 px）、Canvas、WebGL（ANGLE / Direct3D11）、CSS 全部正常；热度图每帧 0.58 毫秒；西夏文随软件字体正常、系统字体显示方框；国旗表情显示成字母 |
| 中文输入法 | 三个框全部 PASS；词中插字、半途退格、Esc 取消、中英切换、加粗输入都正常，候选框位置正确。ProseMirror 的选字事件计数为 0/0（另外两个框 4/4），文字结果正确，原因待 P1 编辑器开发时复查 |
| 安装包与 SmartScreen | 见结论表“安装”一行；主程序 `v0.0.1-p0` 安装包也已在台式机上安装并启动 |

新增结论：

- **读取方也要重试**：替换的一瞬间，别的进程读同一个文件可能拿到 `NotFound`。核心读条目文件时遇到 `NotFound` 应短暂重试一次，再报错。
- **开发服务器绑定 IPv4**：`pnpm tauri dev` 在 Windows 上会因为 Vite 只监听 `::1` 而卡住，已改为明确监听 `127.0.0.1`。

## 未完成或需要用户做的事

- Windows 和 macOS 的清单都已完成（2026-10-18、19）。
- “WebView2 缺失时的安装行为”在 Windows 10/11 上基本无法真实复现，只能以官方文档为准；如果你有一台旧的 Windows 10（1803 以前）或可以卸载 WebView2 的虚拟机，可以补测。
- 网络盘没有测；规范已写明不支持把库放在网络盘上。
- ProseMirror 在 Windows 上选字事件计数为 0/0 的原因，P1 做编辑器时复查。
