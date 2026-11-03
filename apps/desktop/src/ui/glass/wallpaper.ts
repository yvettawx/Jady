// The default wallpaper: the space's three colours as soft light on the mode's base
// (the same colours the glass contrast test checks against).
import { useEffect, useMemo, useState } from "react";
import { MODES, wallColors, type Mode } from "../../theme/tokens.ts";

export function paintWallpaper(
  canvas: HTMLCanvasElement,
  mode: Mode,
  space: readonly string[],
  w: number,
  h: number,
): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  canvas.width = w;
  canvas.height = h;
  const [a, b, c] = wallColors(mode, space);
  g.fillStyle = MODES[mode].canvas;
  g.fillRect(0, 0, w, h);
  const glow = (x: number, y: number, r: number, color: string | undefined) => {
    if (!color) return;
    const q = g.createRadialGradient(x, y, 0, x, y, r);
    q.addColorStop(0, color);
    q.addColorStop(1, color + "00");
    g.fillStyle = q;
    g.fillRect(0, 0, w, h);
  };
  glow(0, 0, w * 0.9, a);
  glow(w, h, w * 0.8, b);
  glow(w * 0.75, 0, w * 0.5, c);
}

/** The default wallpaper at window size in device pixels, repainted after the window settles. */
export function useWallpaper(mode: Mode, space: readonly string[]): HTMLCanvasElement | null {
  const [size, setSize] = useState(() => windowSize());
  useEffect(() => {
    let t = 0;
    const onResize = () => {
      clearTimeout(t);
      t = window.setTimeout(() => setSize(windowSize()), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return useMemo(() => {
    const c = document.createElement("canvas");
    paintWallpaper(c, mode, space, size.w, size.h);
    return c;
  }, [mode, space, size]);
}

function windowSize() {
  const dpr = window.devicePixelRatio || 1;
  return { w: Math.round(window.innerWidth * dpr), h: Math.round(window.innerHeight * dpr) };
}
