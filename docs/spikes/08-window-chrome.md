# 技术验证 08：自绘标题栏（P0.5-07-1）

> 日期：2026-10-25 起。对应 05 设计规范第 2.1 节（标题栏自己画，建议）。

## 要回答的问题

标题栏能不能自己画，两个平台上系统自带的窗口行为会不会丢：拖动窗口、双击、全屏、贴靠、改大小、阴影，以及 Windows 11 鼠标悬停最大化按钮时弹出的贴靠布局。

## 做法

- **macOS**：Tauri 自带的叠加标题栏（`titleBarStyle: Overlay`，`hiddenTitle`），系统的红绿灯保留，用 `trafficLightPosition` 对齐到我们 44 像素高的标题栏（`tauri.macos.conf.json`）。全屏时红绿灯消失，左边留白跟着收起。
- **Windows**：去掉系统边框（`tauri.windows.conf.json`），三个窗口按钮由 [tauri-plugin-frame](https://docs.rs/crate/tauri-plugin-frame/latest) 画（MIT，只在 Windows 上编译）。贴靠布局只能由系统对 `WM_NCHITTEST` 收到 `HTMAXBUTTON` 时弹出，网页里做不到；这个插件在我们的最大化按钮上方放一个透明的原生小窗口来回答它，没有模拟按键。另一个插件 decorum 已进入只维护状态，没选。
- 标题栏里不是按钮的部分都是拖动区域（`data-tauri-drag-region`）。
- 开发版 `#/titlebar` 列出两个平台要人工检查的项。

## macOS 结果（你在 Mac 上测，2026-10-25）

| 检查 | 结果 |
| --- | --- |
| 红绿灯位置、和左边留白对齐 | 正常 |
| 拖标题栏空白处移动窗口；点按钮不拖窗口 | 正常 |
| 双击标题栏空白处 | 正常 |
| 进出全屏 | 正常 |
| 按住绿色按钮的分屏菜单 | 正常 |
| 四边拉伸改大小、窗口阴影 | 正常 |
| 拖边缘改大小时内容跟手 | **能明显感觉到延迟**，见下 |

### 改大小时的延迟

程序一步步改窗口宽度（60 步），测每一步到页面按新尺寸画出来要多久：

| 情况 | 平均 | p95 |
| --- | --- | --- |
| 开着 WebGL 玻璃（改之前） | 37.7 ms | 44 ms |
| 关掉 WebGL | 34 ms | 34 ms |
| 开着 WebGL（画布只分配一次以后） | 33.2 ms | 34 ms |

大约两帧是 WKWebView 自己的：macOS 拖动改大小时同步更新窗口边框，而 WKWebView 把新画面交给系统是异步的，移动的边上会露出一条还没画的区域。这在最小的 Tauri 应用里也能复现（[WebKit bug 323132](https://bugs.webkit.org/show_bug.cgi?id=323132)，修复补丁 [WebKit PR #72971](https://github.com/WebKit/WebKit/pull/72971)；Tauri [#14843](https://github.com/tauri-apps/tauri/issues/14843)；Wails [#6070](https://github.com/wailsapp/wails/issues/6070)），应用代码管不到。

我们做了两件事：WebGL 画布按屏幕大小分配一次，窗口变化只移动视口（去掉了 4 毫秒的额外开销）；窗口和 WebView 的底色设成壁纸底色、跟随深浅色，没画到的那一条不再闪白。剩下的延迟等 WebKit 的修复随 macOS 更新到来，每次 macOS 大版本更新时复查一次。

你的决定（2026-10-25）：先接受这点延迟，跟踪 WebKit 的修复。

## Windows 结果

并进 P0.5-11 双平台检查（2026-10-25 定）：页面 `#/titlebar` 上列了 6 项，重点是悬停最大化按钮时的贴靠布局。插件能否在 Windows 上编译，由每次推送的云端 CI 检查。

## 结论（2026-10-25）

- 标题栏自己画：macOS 用叠加标题栏，实测通过；Windows 先按 tauri-plugin-frame 方案做，P0.5-11 验证。
- 退路：Windows 的贴靠布局留不住时，Windows 改回系统标题栏。两个平台的差别都收在 `TitleBar` 组件和各自的窗口配置（`tauri.macos.conf.json`、`tauri.windows.conf.json`）里，改动不影响外壳的其他部分。
- 拖边缘改大小时的延迟是 WKWebView 的已知问题，先接受，跟踪 WebKit 修复。
