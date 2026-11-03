// Shown by development builds opened in a plain browser, where the app itself cannot run
// (it needs Tauri). Lists the development pages instead of failing.
const PAGES = [
  ["#/sample", "样板间", "所有基础组件，顶上可以切换外观"],
  ["#/glass", "玻璃实验页", "WebGL 折射、玻璃设置、帧率测试"],
  ["#/screens/ai", "界面：AI", "P0.5-09，对话窗口、三种动作、授权对话；假的回答，不接 AI"],
  ["#/screens/heatmap", "界面：热度图", "P0.5-08，年历墙，三种尺寸"],
  ["#/screens/privacy", "界面：隐私层级", "P0.5-07-9，四个层级、受保护的链接、打开前验证"],
  ["#/screens/settings", "界面：设置", "P0.5-07-8，外观和快捷键，改了立刻生效"],
  ["#/screens/launcher", "界面：启动器", "P0.5-07-7，⌘K；底部是每种指令的例子"],
  ["#/screens/capture", "界面：全局收集", "P0.5-07-7，收集小窗口的样子"],
  ["#/screens/board", "界面：表格和看板", "P0.5-07-6，拖卡片改状态，点开详情"],
  [
    "#/screens/editor",
    "界面：编辑器排版",
    "P0.5-07-5，正文、代码、Mermaid、内链、记忆卡、版本对比",
  ],
  ["#/screens/home", "界面：首页", "P0.5-07-3，星图加小组件；点最左栏图标浮出面板"],
  ["#/screens/shell", "界面：外壳", "P0.5-07-2，三个空间，窗口拉窄看收列"],
  ["#/screens/unlock", "界面：解锁与建库", "P0.5-07-4，底部可以跳到任意一步"],
  ["#/titlebar", "标题栏", "自绘标题栏的实测项，要在 Tauri 窗口里看"],
  ["#/workspace", "工作区", "停靠布局、页签、打开的内容；?dnd=html5 换成原生拖放"],
] as const;

export function DevIndex() {
  return (
    <main style={{ padding: "var(--dem-space-6)", maxWidth: 560 }}>
      <h1 style={{ fontFamily: "var(--dem-font-display)" }}>Jady</h1>
      <p style={{ color: "var(--dem-muted)" }}>
        这是开发版，在普通浏览器里打开的。软件本身要在 Tauri 窗口里运行（pnpm tauri
        dev），这里可以看开发用的页面：
      </p>
      <ul>
        {PAGES.map(([href, name, note]) => (
          <li key={href} style={{ marginBottom: "var(--dem-space-2)" }}>
            <a href={href} onClick={() => setTimeout(() => location.reload())}>
              {name}
            </a>
            <span style={{ color: "var(--dem-muted)" }}> {note}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
