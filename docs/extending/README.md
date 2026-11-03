# 扩展这个软件

读完这一页就知道能改什么、从哪里改。让 AI 来做的话，把 `skills/` 下对应的 SKILL 给它读。

## 能做什么

| 想做的事                                                     | 走哪里                   | 文档                           |
| ------------------------------------------------------------ | ------------------------ | ------------------------------ |
| 写一个别人能装的插件：面板、命令，在沙箱里运行，不用改软件   | 外部插件                 | [external-plugins.md](external-plugins.md) |
| 加一个面板、命令、启动器结果、首页小组件、侧栏视图、设置分区 | 构建时带上的插件         | [plugin-api.md](plugin-api.md) |
| 加一套配色、调颜色、字体、间距、圆角                         | 插件或主题令牌           | [theming.md](theming.md)       |
| 改现有界面的布局和交互                                       | 改源码                   | [ui-changes.md](ui-changes.md) |
| 加一组内容类型，用户一键添加                                 | 插件                     | [templates.md](templates.md)   |
| 加一种内容类型和字段                                         | 软件里直接建，不用写代码 | 下面                           |
| 改快捷键、外观                                               | 软件的设置里直接改       | 下面                           |
| 让代码题支持一种新语言                                       | 改源码，加一行语言表     | 下面                           |
| 给 AI 加不碰库内容的工具（像专用浏览器）                     | 改 Rust 源码             | [app-tools.md](app-tools.md)   |

**不写代码也能做的：**

- 新类型：左边的“类型”视图点“新建类型”，填名字和字段，表格和看板自动有。
- 导入表格：设置的“资料库”分区选 CSV 或 Excel，会新建一个类型。
- 快捷键、配色、字体、字号、玻璃效果：都在设置里，改了立刻生效。
- 自定义 CSS：设置的“外观”最下面，写了立刻生效。
- 首页小组件：首页右上角“调整小组件”，拖动、改大小、增删。
- AI 工作约定：设置的“AI”分区写全局的；打开一个领域或项目，可以写它自己的。下层覆盖上层。
- 定期任务：左边“生活”里的“定期任务”，正文写要求，选频率。只能看普通内容，结果进收集箱。
- 同步到自己的服务器：见 [../user/sync-server.md](../user/sync-server.md)。

## 代码题加一种语言

代码题在系统沙盒里用本机的工具链运行。加一种语言，就在 `apps/desktop/src-tauri/src/coderun.rs` 的 `lang()` 里加一项：

```rust
"kotlin" | "kt" => l(
    "Kotlin",              // 显示的名字
    "answer.kt",           // 答案存成的文件
    "kotlinc",             // 在本机找的程序
    Some(&["answer.kt", "-include-runtime", "-d", "answer.jar"]), // 编译参数，不用编译就写 None
    &[],                   // 不编译时，运行用的参数
    "brew install kotlin", // 没装时提示的安装命令
    false,                 // 是不是 Xcode 开发工具里的
),
```

再在同一个文件测试里的 `ANSWERS` 加一个“读两个数、输出和”的答案，运行 `cargo test -p dem-desktop coderun`，没装这种语言的电脑会跳过。编译产物要叫 `answer`，或者像上面这样需要另一个程序来运行时，再改 `run_tests` 里的运行步骤。工具链装在家目录下（比如 `~/.sdkman`）时，`toolchain_access` 会放开它所在的目录给沙盒读。沙盒本身的规则在 `crates/dem-sandbox/src/native.rs`，不要为某种语言放宽联网和读家目录。

## 五分钟写一个插件

一个插件就是 `apps/desktop/src/plugins/` 下的一个文件夹，里面有 `index.ts` 或 `index.tsx`。构建时自动带上。

```bash
cd apps/desktop
cp -r src/plugins/_example src/plugins/browse
pnpm tauri dev
```

打开软件、解锁资料库，就能看到：左边多了一个视图，首页多了一个小组件，⌘K 能搜到“随便翻一条”，设置里多了一个分区和一套配色。`_example` 把每种扩展点都用了一次，改它是最快的开始方式。

名字以 `_` 开头的文件夹不会被带上。

## 现在的限制

- 插件是构建时带上的，改了要重新构建。从外部文件夹加载要先解决权限问题，见 [../extensibility-review.md](../extensibility-review.md)。
- 插件和软件本身跑在同一个界面进程里，权限一样大。只用你信任的插件。
- 正文的结构（节点和标记的名字）属于存储格式，插件不能增加。改这个要走格式版本升级，见 `docs/format-spec.md`。

## 必须遵守的规则

这些是整个项目的硬性规则，插件也一样，详细的在 `CLAUDE.md`：

- 数据只走 `ctx.data`，它通往 `dem-core` 的门面。不直接读写库文件。
- 界面文字放语言表（`addMessages`），不写死在代码里。至少给 `zh-CN`。
- 机密内容的标题只出现在目录里。自己列内容时，`privacy` 是 `confidential` 的不要显示标题。
- 改设置的命令标上 `changesSettings: true`，这种命令永远不会给 AI 用。
- 不把密钥写进代码、配置或日志，也不记录正文内容。

## 怎么验证

```bash
pnpm run check
pnpm run probe:app
```

`check` 跑格式、静态检查、类型和单元测试，里面包括检查写死文字的测试和文案规则。`probe:app` 用真实的 Rust 核心把整个软件走一遍。
