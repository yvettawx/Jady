// The layer behind the whole window: draws the backdrop and, through WebGL, the refraction
// inside every registered glass panel. Without WebGL, or with 减少透明度 on, it just shows the
// backdrop and the panels use CSS blur. Given a `sink` (the home star map, which draws the
// glass in its own context), it only collects the panels and hands them over each frame.
import { useEffect, useRef, useState } from "react";
import { useColorMode } from "../../theme/mode.ts";
import { glassBlur, glassPaint } from "../../theme/tokens.ts";
import { useGlass } from "./context";
import { createGlassRenderer, type GlassSink, type PanelRect } from "./renderer";

/** Where each refracting glass panel is this frame, in CSS px. */
function collectPanels(elements: () => Iterable<HTMLElement>): PanelRect[] {
  const panels: PanelRect[] = [];
  for (const el of elements()) {
    if (!el.isConnected || !el.hasAttribute("data-glass-refract")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    // Kept in place but hidden (the workspace under the home page): nothing to draw.
    if (el.closest("[data-glass-hidden]")) continue;
    panels.push({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
    });
  }
  return panels;
}

export function GlassBackdrop({
  source,
  live = false,
  accent,
  webgl = true,
  sink,
}: {
  /** What is behind the glass, sized to the window in device pixels (wallpaper or scene). */
  source: HTMLCanvasElement | null;
  /** The source changes every frame (the home scene), so re-upload it each frame. */
  live?: boolean;
  accent?: string;
  /** Off forces the CSS-blur fallback (for comparison and as a performance setting). */
  webgl?: boolean;
  /** Draws the glass instead of this layer; the source then shows itself. */
  sink?: GlassSink | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const plain = useRef<HTMLCanvasElement>(null);
  const { settings, reduce, elements, setRefracting } = useGlass();
  const mode = useColorMode();
  // Keep the latest values for the frame loop without restarting it.
  const latest = useRef({ settings, mode, accent, live });
  useEffect(() => {
    latest.current = { settings, mode, accent, live };
  });

  // The GPU can drop the WebGL context (sleep, switching graphics cards or displays). Then the
  // panels fall back to CSS blur until the browser restores it, and the layer starts again.
  const [lost, setLost] = useState(false);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const onLost = (e: Event) => {
      e.preventDefault(); // asks the browser to restore the context later
      setLost(true);
    };
    const onRestored = () => {
      setLost(false);
      setEpoch((n) => n + 1);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !source || reduce || !webgl || lost || sink) {
      if (!sink) setRefracting(false);
      return;
    }
    const renderer = createGlassRenderer(canvas);
    if (!renderer) {
      setRefracting(false);
      return;
    }
    setRefracting(true);
    let frame = 0,
      last = "",
      uploaded = false;
    const fit = () => {
      renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      last = "";
    };
    fit();
    window.addEventListener("resize", fit);
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      const { settings: s, mode: m, accent: acc, live: isLive } = latest.current;
      if (isLive || !uploaded) {
        renderer.setSource(source);
        // Lets the probe check the backdrop was repainted for the current window size.
        if (import.meta.env.DEV) canvas.dataset.source = `${source.width}x${source.height}`;
        uploaded = true;
        last = "";
      }
      const panels = collectPanels(elements);
      const paint = glassPaint(m, s.alpha, s.tinted, acc);
      const key = JSON.stringify([panels, paint]);
      if (key === last) return;
      last = key;
      renderer.draw(panels, paint, glassBlur(s.alpha));
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
      renderer.dispose();
      setRefracting(false);
    };
  }, [source, reduce, webgl, lost, epoch, elements, setRefracting, sink]);

  // Sink mode: the panels go to whoever draws them.
  useEffect(() => {
    if (!sink || reduce || !webgl) return;
    setRefracting(true);
    let frame = 0,
      last = "";
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      const { settings: s, mode: m, accent: acc } = latest.current;
      const panels = collectPanels(elements);
      const paint = glassPaint(m, s.alpha, s.tinted, acc);
      const key = JSON.stringify([panels, paint]);
      if (key === last) return;
      last = key;
      sink.setGlass(panels, paint, glassBlur(s.alpha));
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      sink.setGlass([], { r: 0, g: 0, b: 0, a: 0 }, 0);
      setRefracting(false);
    };
  }, [sink, reduce, webgl, elements, setRefracting]);

  // Fallback: show the backdrop as it is; panels blur it with CSS.
  useEffect(() => {
    const c = plain.current;
    // A window that has no size yet (opened hidden) has an empty wallpaper; nothing to draw.
    if (!c || !source || !source.width || !source.height) return;
    c.width = source.width;
    c.height = source.height;
    c.getContext("2d")?.drawImage(source, 0, 0);
  }, [source, reduce]);

  return (
    <>
      {/* A live source (the home scene) shows itself; a copy here would stand still. */}
      <canvas ref={plain} className="dem-backdrop" aria-hidden hidden={live} />
      <canvas
        ref={ref}
        className="dem-backdrop"
        aria-hidden
        hidden={reduce || !webgl || lost || !!sink}
      />
    </>
  );
}
