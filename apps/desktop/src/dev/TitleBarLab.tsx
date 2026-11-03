// Title bar lab (P0.5-07-1), development builds only: #/titlebar. Open it in the Tauri window
// and work through the checks listed on the page.
import { useEffect, useState } from "react";
import { useColorMode } from "../theme/mode.ts";
import { SCHEMES } from "../theme/tokens.ts";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { GlassBackdrop } from "../ui/glass/GlassBackdrop";
import { GlassProvider } from "../ui/glass/GlassProvider";
import { useWallpaper } from "../ui/glass/wallpaper";
import { Tooltip } from "../ui/Tooltip";
import { currentPlatform, inTauri } from "../shell/platform";
import { TitleBar } from "../shell/TitleBar";
import "./lab.css";

const CHECKS: Record<string, string[]> = {
  mac: [
    "红绿灯在标题栏里垂直居中，和左边的留白对齐",
    "拖标题栏空白处能移动窗口；点“搜索”“AI”按钮不会拖动窗口",
    "双击标题栏空白处：和系统设置“双击窗口标题栏以…”的选项一致吗",
    "绿色按钮进全屏：红绿灯消失，左边留白也收起；退出全屏后恢复",
    "按住绿色按钮出现的分屏菜单正常",
    "窗口四边和四角都能拉伸改大小，窗口有阴影",
  ],
  windows: [
    "右上角有最小化、最大化、关闭三个按钮，悬停有颜色",
    "鼠标停在最大化按钮上，弹出 Windows 11 的贴靠布局，选一个格子能贴过去",
    "拖标题栏到屏幕顶部最大化、拖到左右边缘半屏贴靠",
    "双击标题栏空白处最大化、再双击还原",
    "在标题栏空白处右键，或按 Alt+空格，出现系统菜单",
    "窗口四边都能拉伸改大小，窗口有阴影",
  ],
};

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");

/**
 * ?resize: steps the window width by 8 px for 60 steps and measures, per step, how long until
 * the page has laid out and painted at the new size. ?resize&webgl=0 does the same with the
 * WebGL layer off. Results go to the dev server (.perf/).
 */
async function measureResize() {
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  const h = window.innerHeight;
  const lags: number[] = [];
  for (let i = 0; i < 60; i++) {
    const target = 900 + (i % 30) * 8 * (i < 30 ? 1 : -1) + (i < 30 ? 0 : 240);
    const t0 = performance.now();
    await w.setSize(new LogicalSize(target, h));
    await new Promise<void>((done) => {
      const check = () =>
        window.innerWidth === target
          ? requestAnimationFrame(() => done())
          : requestAnimationFrame(check);
      check();
    });
    lags.push(performance.now() - t0);
  }
  const sorted = [...lags].sort((a, b) => a - b);
  const r = {
    name: `resize-${params.get("webgl") === "0" ? "css" : "webgl"}`,
    steps: lags.length,
    avgMs: +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1),
    p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1),
    maxMs: +(sorted.at(-1) ?? 0).toFixed(1),
  };
  await fetch("/__perf", { method: "POST", body: JSON.stringify(r) });
}

function Lab() {
  const mode = useColorMode();
  const platform = currentPlatform();
  const wallpaper = useWallpaper(mode, SCHEMES.aurora[0]);
  const [state, setState] = useState(() =>
    inTauri() ? "…" : "不在 Tauri 窗口里，窗口相关的项只能在 Tauri 里测",
  );
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const sync = async () =>
        setState(
          `最大化：${(await w.isMaximized()) ? "是" : "否"}；全屏：${(await w.isFullscreen()) ? "是" : "否"}`,
        );
      await sync();
      off = await w.onResized(() => void sync());
      if (params.has("resize")) setTimeout(() => void measureResize(), 1500);
    });
    return () => off?.();
  }, []);

  return (
    <div className="lab">
      <GlassBackdrop
        source={wallpaper}
        accent={SCHEMES.aurora[0][0]}
        webgl={params.get("webgl") !== "0"}
      />
      <TitleBar>
        <span className="lab-space">主空间</span>
        <span className="lab-titlebar-gap" data-tauri-drag-region />
        <Tooltip label="搜索" shortcut="Mod+K">
          <Button variant="quiet" size="sm" icon="search" aria-label="搜索" />
        </Tooltip>
        <Tooltip label="问 AI" shortcut="Mod+J">
          <Button variant="quiet" size="sm" icon="ai" aria-label="问 AI" />
        </Tooltip>
      </TitleBar>
      <Glass className="lab-panel lab-titlebar-checks" style={{ left: 16, top: 60, width: 560 }}>
        <h2>
          标题栏实测（{platform === "mac" ? "macOS" : platform === "windows" ? "Windows" : platform}
          ）
        </h2>
        <p className="lab-quiet">{state}</p>
        <ol>
          {(CHECKS[platform] ?? CHECKS.mac ?? []).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </Glass>
    </div>
  );
}

export function TitleBarLab() {
  return (
    <GlassProvider accent={SCHEMES.aurora[0][0]}>
      <Lab />
    </GlassProvider>
  );
}
