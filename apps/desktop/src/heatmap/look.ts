// What the heat map views share: the size of their canvas and colours read from the design
// tokens, so a recoloured type or another colour mode follows without any code knowing them.
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useColorMode } from "../theme/mode.ts";

export interface HeatLook {
  types: Record<string, string>;
  text: string;
  muted: string;
  line: string;
  accent: string;
  font: string;
}

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function useHeatLook(types: readonly string[]): HeatLook {
  const mode = useColorMode();
  // The mode is only here to read the tokens again when it changes.
  return useMemo(
    () => ({
      types: Object.fromEntries(
        types.map((t) => [t, css(`--dem-content-${t}`) || css("--dem-accent")]),
      ),
      text: css("--dem-on-glass"),
      muted: css("--dem-on-glass-muted"),
      line: css("--dem-line"),
      accent: css("--dem-accent"),
      font: css("--dem-font-ui"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [types, mode],
  );
}

/** The element's size in CSS px, following it as it changes. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Sizes a 2D canvas for the screen and scales its context to CSS px. */
export function fitCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  const ratio = devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }
  const g = canvas.getContext("2d");
  g?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return g;
}

export const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
