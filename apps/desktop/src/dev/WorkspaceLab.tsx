// Workspace lab (P0.5-06-7), development builds only: #/workspace. The real workspace wrapper
// with demo panels over the glass wallpaper. window.__ws exposes the API to the probe script.
// Query: ?dnd=html5 switches dockview back to HTML5 drag-and-drop for comparison.
import { useState } from "react";
import { SCHEMES } from "../theme/tokens.ts";
import { useColorMode } from "../theme/mode.ts";
import { Button } from "../ui/Button";
import { GlassBackdrop } from "../ui/glass/GlassBackdrop";
import { GlassProvider } from "../ui/glass/GlassProvider";
import { useWallpaper } from "../ui/glass/wallpaper";
import { Segmented } from "../ui/Segmented";
import type { WorkspaceApi } from "../workspace/api";
import type { Layout } from "../workspace/layout";
import { DEFAULT_LAYOUT, NOTES } from "./demo";
import { Workspace, type TabArrangement } from "../workspace/Workspace";
import "./lab.css";

declare global {
  interface Window {
    __ws?: WorkspaceApi;
  }
}

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
const DND = params.get("dnd") === "html5" ? "html5" : "pointer";

/** ?diag: reports how glass is drawn in this webview to the dev server (.perf/), for the Tauri window. */
function reportDiagnostics() {
  const c = [...document.querySelectorAll<HTMLCanvasElement>("canvas.dem-backdrop")].find(
    (x) => x.dataset.source,
  );
  const gl = document.createElement("canvas").getContext("webgl");
  const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
  const groups = [...document.querySelectorAll<HTMLElement>(".dv-groupview")].map((g) => ({
    refract: g.hasAttribute("data-refract"),
    bg: getComputedStyle(g).backgroundColor,
    backdrop:
      getComputedStyle(g).backdropFilter ||
      getComputedStyle(g).getPropertyValue("-webkit-backdrop-filter"),
  }));
  // Just outside each cell's rounded top-left corner the layer should show plain wallpaper.
  const corners = (() => {
    const src =
      c && document.querySelector<HTMLCanvasElement>("canvas.dem-backdrop:not([data-source])");
    if (!c || !src) return null;
    const read = (canvas: HTMLCanvasElement, x: number, y: number) => {
      const t = document.createElement("canvas");
      t.width = 1;
      t.height = 1;
      const g = t.getContext("2d");
      g?.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
      return [...(g?.getImageData(0, 0, 1, 1).data ?? [])].slice(0, 3);
    };
    return [...document.querySelectorAll<HTMLElement>(".dv-groupview")].map((g) => {
      const b = g.getBoundingClientRect();
      const x = Math.round((b.left + 2) * devicePixelRatio),
        y = Math.round((b.top + 2) * devicePixelRatio);
      const drawn = read(c, x, y),
        wall = read(src, x, y);
      return { drawn, wall, diff: drawn.reduce((s, v, i) => s + Math.abs(v - (wall[i] ?? 0)), 0) };
    });
  })();
  // Points outside every panel: the layer must show exactly the wallpaper there.
  const open = (() => {
    const src =
      c && document.querySelector<HTMLCanvasElement>("canvas.dem-backdrop:not([data-source])");
    if (!c || !src) return null;
    const d = devicePixelRatio;
    const pts: [number, number][] = [
      [6, 6],
      [innerWidth - 6, 6],
      [6, innerHeight - 4],
      [innerWidth - 6, innerHeight - 4],
      [innerWidth / 2, 30],
    ];
    const read = (canvas: HTMLCanvasElement, x: number, y: number) => {
      const t = document.createElement("canvas");
      t.width = 1;
      t.height = 1;
      const g = t.getContext("2d");
      g?.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
      return [...(g?.getImageData(0, 0, 1, 1).data ?? [])].slice(0, 3);
    };
    return pts.map(([x, y]) => ({
      at: [x, y],
      drawn: read(c, x * d, y * d),
      wall: read(src, x * d, y * d),
    }));
  })();
  const r = {
    name: "glass-diag",
    mode:
      document.documentElement.dataset.theme ??
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    open,
    corners,
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    webgl: !!gl,
    renderer: dbg && gl ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    backdropCanvas: c
      ? { source: c.dataset.source, size: `${c.width}x${c.height}`, hidden: c.hidden }
      : null,
    groups,
  };
  fetch("/__perf", { method: "POST", body: JSON.stringify(r) }).catch(() => {});
}

function Lab() {
  const mode = useColorMode();
  const [api, setApi] = useState<WorkspaceApi | null>(null);
  const [arrangement, setArrangement] = useState<TabArrangement>("horizontal");
  const [saved, setSaved] = useState<Layout | null>(null);
  const source = useWallpaper(mode, SCHEMES.aurora[0]);

  return (
    <div className="lab">
      <GlassBackdrop source={source} accent={SCHEMES.aurora[0][0]} />
      <div className="lab-toolbar">
        <Segmented
          aria-label="页签排法"
          options={[
            { id: "horizontal", label: "横排" },
            { id: "vertical", label: "竖排" },
          ]}
          value={arrangement}
          onChange={(id) => setArrangement(id as TabArrangement)}
        />
        <Button
          size="sm"
          onPress={() =>
            api?.open(
              { contentId: "cv", title: NOTES.cv ?? "", component: "note" },
              { kind: "preview" },
            )
          }
        >
          预览简历
        </Button>
        <Button
          size="sm"
          onPress={() =>
            api?.open(
              { contentId: "l11", title: NOTES.l11 ?? "", component: "note" },
              { split: "right" },
            )
          }
        >
          分屏打开
        </Button>
        <Button size="sm" onPress={() => api && setSaved(api.save())}>
          保存布局
        </Button>
        <Button size="sm" isDisabled={!saved} onPress={() => saved && api?.load(saved)}>
          恢复布局
        </Button>
        <span className="lab-quiet">拖动：{DND === "pointer" ? "指针事件" : "HTML5"}</span>
      </div>
      <div className="lab-ws">
        <Workspace
          arrangement={arrangement}
          dndStrategy={DND}
          onReady={(ws) => {
            ws.load(DEFAULT_LAYOUT);
            window.__ws = ws;
            setApi(ws);
            if (params.has("diag")) setTimeout(reportDiagnostics, 2000);
          }}
        />
      </div>
    </div>
  );
}

export function WorkspaceLab() {
  return (
    <GlassProvider accent={SCHEMES.aurora[0][0]}>
      <Lab />
    </GlassProvider>
  );
}
