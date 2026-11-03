# 改现有界面

## 目录

```
apps/desktop/src/
  app/         软件本身：解锁后的工作台、各个面板、和核心打交道
    api.ts     唯一通往核心的门
    store.ts   条目、类型、结构的本地副本，改动后自动刷新
    Workbench.tsx  外壳接真数据，登记面板和命令
    panels/    笔记、目录、表格看板、版本、首页小组件、设置分区
  editor/      编辑器
    pm/        ProseMirror：schema、命令、[[ 和 / 菜单、块的显示
    NoteSheet.tsx  一张纸的外观和格式栏
  shell/       窗口骨架：标题栏、最左边的栏、状态栏、命令登记
  workspace/   页签和分栏
  views/       表格和看板
  launcher/    启动器
  home/        首页和星图
  settings/    设置页
  privacy/     隐私层级的规则和界面
  ui/          基础组件
  theme/       令牌和配色
  i18n/        语言表
  plugins/     插件
  bindings.ts  从 Rust 生成的类型，不要手改
apps/desktop/src-tauri/src/lib.rs   界面能调的命令
crates/dem-core/                    服务门面，所有数据操作都在这里
```

## 常见改动

**加一个按钮或菜单项：** 找到对应组件，文字加进 `src/i18n/zh-CN.json` 和 `en.json`，用 `t("key")`。

**改布局：** 默认布局在 `src/app/Workbench.tsx` 的 `defaultLayout`。用户拖过之后会存下来，要看到默认效果得用新的资料库。

**加一个新操作的数据支持：**

1. 在 `crates/dem-core/src/session.rs` 加方法，写测试。
2. 在 `apps/desktop/src-tauri/src/lib.rs` 加命令，登记进 `collect_commands!`。
3. 运行 `cargo test -p dem-desktop export_bindings`，生成 `bindings.ts`。
4. 界面里用 `api.xxx()`。出错时它会抛异常，用 `failed(t, 描述)` 接住。

**改存储格式：** 先读 `docs/format-spec.md`。任何改动都要带格式版本升级和迁移。

## 不能破的规矩

- 界面和 AI 只通过 `dem-core` 拿数据。
- 文字不写死。`src/i18n/no-hardcoded.test.ts` 会查出来。
- 焦点不能丢：按钮按完自己消失时，焦点要有地方去，见 `src/ui/focus.ts` 和 05 文档的 §3.7。
- 能被插件扩展的东西走登记机制，不要在界面里写死清单。
- 隐私判断问 `src/privacy/policy.ts`，不要自己写。

## 怎么看效果

```bash
cd apps/desktop
pnpm tauri dev
```

不想建库、只看界面的话，浏览器打开开发页：

```bash
pnpm run dev
```

`#/screens/shell`、`#/screens/editor`、`#/screens/board`、`#/sample` 这些页面用假数据展示各部分，不碰真实资料。

## 怎么验证

```bash
pnpm run check
pnpm run probe:app
```

改了哪部分，就再跑 `package.json` 里对应的 `probe:*`。它们在 Chromium 和 WebKit 里真的点一遍。
