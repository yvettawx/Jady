// Glass lab (P0.5-06-6), development builds only: #/glass. Drag the panels over the wallpaper,
// change the glass setting, compare WebGL refraction with the CSS-blur fallback.
// #/glass?perf=webgl|css&seconds=8 moves every panel each frame and reports frame times.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useColorMode } from "../theme/mode.ts";
import { GLASS, SCHEMES } from "../theme/tokens.ts";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { GlassBackdrop } from "../ui/glass/GlassBackdrop";
import { GlassProvider } from "../ui/glass/GlassProvider";
import { useGlass } from "../ui/glass/context";
import { paintWallpaper } from "../ui/glass/wallpaper";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import { useT } from "../i18n/context";
import "./lab.css";

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
const PERF = params.get("perf"); // "webgl" | "css" | null
const SECONDS = Number(params.get("seconds") ?? 8);

type Box = { id: string; x: number; y: number; w: number; h: number; title: string };
const START: Box[] = [
  { id: "bar", x: 16, y: 16, w: 56, h: 520, title: "" },
  { id: "left", x: 88, y: 16, w: 250, h: 520, title: "目录" },
  { id: "right", x: 900, y: 16, w: 260, h: 300, title: "大纲" },
  { id: "w1", x: 900, y: 332, w: 260, h: 204, title: "01 今日待办" },
  { id: "w2", x: 360, y: 400, w: 240, h: 136, title: "02 热度图" },
  { id: "w3", x: 620, y: 400, w: 260, h: 136, title: "03 提醒" },
];

function Draggable({
  box,
  onMove,
  children,
}: {
  box: Box;
  onMove: (x: number, y: number) => void;
  children: ReactNode;
}) {
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  return (
    <Glass
      className="lab-panel"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h } as CSSProperties}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, input, [role=slider], [role=switch]"))
          return;
        start.current = { px: e.clientX, py: e.clientY, x: box.x, y: box.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) onMove(s.x + e.clientX - s.px, s.y + e.clientY - s.py);
      }}
      onPointerUp={() => (start.current = null)}
    >
      {children}
    </Glass>
  );
}

function Controls({
  webgl,
  setWebgl,
  stripes,
  setStripes,
}: {
  webgl: boolean;
  setWebgl: (v: boolean) => void;
  stripes: boolean;
  setStripes: (v: boolean) => void;
}) {
  const t = useT();
  const { settings, setSettings, refracting, reduce, systemReduce } = useGlass();
  const mode = useColorMode();
  return (
    <div className="lab-controls">
      <Segmented
        aria-label={t("glass.material")}
        options={[
          { id: "clear", label: t("glass.clear") },
          { id: "tinted", label: t("glass.tinted") },
        ]}
        value={settings.tinted ? "tinted" : "clear"}
        onChange={(id) => setSettings({ ...settings, tinted: id === "tinted" })}
      />
      <Slider
        label={t("glass.opacity")}
        minValue={GLASS.alphaMin}
        maxValue={GLASS.alphaMax}
        step={0.01}
        value={settings.alpha}
        onChange={(v) => setSettings({ ...settings, alpha: v })}
        showValue
      />
      <Switch
        isSelected={reduce}
        isDisabled={systemReduce}
        onChange={(v) => setSettings({ ...settings, reduce: v })}
      >
        {t("glass.reduce")}
      </Switch>
      {systemReduce && <span className="dem-field-hint">{t("glass.reduceBySystem")}</span>}
      <Switch
        isSelected={mode === "dark"}
        onChange={(v) => (document.documentElement.dataset.theme = v ? "dark" : "light")}
      >
        深色
      </Switch>
      <Switch isSelected={webgl} onChange={setWebgl}>
        WebGL 折射
      </Switch>
      <Switch isSelected={stripes} onChange={setStripes}>
        斜纹壁纸
      </Switch>
      <p className="lab-status" data-testid="glass-status">
        {reduce ? "实底" : refracting ? "WebGL 折射" : "CSS 模糊"}
      </p>
    </div>
  );
}

function Lab() {
  const mode = useColorMode();
  const [webgl, setWebgl] = useState(PERF !== "css");
  const [stripes, setStripes] = useState(true);
  const [boxes, setBoxes] = useState(START);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [result, setResult] = useState("");
  const space = SCHEMES.aurora[0];

  // Wallpaper at window size in device pixels, repainted on resize and mode change.
  useEffect(() => {
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const c = document.createElement("canvas");
      paintWallpaper(c, mode, space, Math.round(innerWidth * dpr), Math.round(innerHeight * dpr));
      if (stripes) {
        const g = c.getContext("2d");
        if (!g) return setSource(c);
        g.strokeStyle = mode === "dark" ? "rgba(255,255,255,.35)" : "rgba(20,20,40,.45)";
        g.lineWidth = 3 * dpr;
        for (let x = -c.height; x < c.width; x += 28 * dpr) {
          g.beginPath();
          g.moveTo(x, c.height);
          g.lineTo(x + c.height, 0);
          g.stroke();
        }
      }
      setSource(c);
    };
    paint();
    addEventListener("resize", paint);
    return () => removeEventListener("resize", paint);
  }, [mode, stripes, space]);

  // Performance run: every panel drifts each frame so the layer redraws every frame.
  useEffect(() => {
    if (!PERF) return;
    const frames: number[] = [];
    let raf = 0,
      last = performance.now();
    const t0 = last;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - t0 > 2000) frames.push(now - last);
      last = now;
      const k = (now - t0) / 1000;
      setBoxes(
        START.map((b, i) => ({
          ...b,
          x: b.x + Math.sin(k * 1.3 + i) * 40,
          y: b.y + Math.cos(k + i) * 12,
        })),
      );
      if (now - t0 > 2000 + SECONDS * 1000) {
        cancelAnimationFrame(raf);
        const sorted = [...frames].sort((a, b) => a - b);
        const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
        const r = {
          name: `glass-${PERF}-${navigator.userAgent.includes("Chrome/") ? "chromium" : "webkit"}`,
          ua: navigator.userAgent,
          dpr: devicePixelRatio,
          w: innerWidth,
          h: innerHeight,
          panels: START.length,
          frames: frames.length,
          fps: +(1000 / avg).toFixed(1),
          avgMs: +avg.toFixed(2),
          p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
          over20ms: frames.filter((f) => f > 20).length,
        };
        setResult(JSON.stringify(r));
        fetch("/__perf", { method: "POST", body: JSON.stringify(r) }).catch(() => {});
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const move = (id: string) => (x: number, y: number) =>
    setBoxes((bs) => bs.map((b) => (b.id === id ? { ...b, x, y } : b)));

  return (
    <div className="lab">
      <GlassBackdrop source={source} accent={space[0]} webgl={webgl} />
      <div className="lab-paper">
        <h1>第 12 课 Le passé composé</h1>
        <p>正文是一张实底的纸，玻璃只用在外壳。拖动两边的玻璃面板，看背后的斜纹在边缘怎样弯折。</p>
      </div>
      {boxes.map((b) => (
        <Draggable key={b.id} box={b} onMove={move(b.id)}>
          {b.id === "left" ? (
            <Controls webgl={webgl} setWebgl={setWebgl} stripes={stripes} setStripes={setStripes} />
          ) : b.id === "bar" ? null : (
            <div className="lab-widget">
              <h2>{b.title}</h2>
              <p>玻璃上的文字用 on-glass 颜色。</p>
              {b.id === "w1" && <Button size="sm">打开</Button>}
            </div>
          )}
        </Draggable>
      ))}
      {result && (
        <pre className="lab-result" data-testid="perf-result">
          {result}
        </pre>
      )}
    </div>
  );
}

export function GlassLab() {
  const accent = useMemo(() => SCHEMES.aurora[0][0], []);
  return (
    <GlassProvider accent={accent}>
      <Lab />
    </GlassProvider>
  );
}
