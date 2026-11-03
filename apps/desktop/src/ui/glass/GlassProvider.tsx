// Applies the glass setting as CSS variables, keeps the list of glass panels, and moves the
// pointer-following light and rim (docs/05-design.md §15) on all of them.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toCss } from "../../theme/color.ts";
import { useColorMode } from "../../theme/mode.ts";
import { useSystemReduceTransparency } from "../../theme/system.ts";
import { glassBlur, glassPaint } from "../../theme/tokens.ts";
import { GlassContext, type GlassContextValue } from "./context";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "./settings";
import "./glass.css";

export function GlassProvider({
  accent,
  initial = DEFAULT_GLASS_SETTINGS,
  settings: controlled,
  onSettingsChange,
  children,
}: {
  /** The current space's colour, used by 着色. */
  accent?: string;
  initial?: GlassSettings;
  /** Given, the setting lives outside (Appearance) and changes go to onSettingsChange. */
  settings?: GlassSettings;
  onSettingsChange?: (s: GlassSettings) => void;
  children: ReactNode;
}) {
  const mode = useColorMode();
  const [own, setOwn] = useState(initial);
  const settings = controlled ?? own;
  // Stable, so the context value (and every panel's registration) does not change with it.
  const onChange = useRef(onSettingsChange);
  useEffect(() => {
    onChange.current = onSettingsChange;
  });
  const setSettings = useCallback(
    (s: GlassSettings) => (onChange.current ? onChange.current(s) : setOwn(s)),
    [],
  );
  const [refracting, setRefracting] = useState(false);
  const systemReduce = useSystemReduceTransparency();
  const reduce = settings.reduce || systemReduce;
  const els = useRef(new Set<HTMLElement>());

  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty(
      "--dem-glass",
      toCss(glassPaint(mode, settings.alpha, settings.tinted, accent)),
    );
    root.setProperty("--dem-glass-blur", `${glassBlur(settings.alpha)}px`);
    document.documentElement.toggleAttribute("data-reduce-transparency", reduce);
    return () => {
      root.removeProperty("--dem-glass");
      root.removeProperty("--dem-glass-blur");
      document.documentElement.removeAttribute("data-reduce-transparency");
    };
  }, [mode, settings, accent, reduce]);

  // One pointer listener for all panels, at most once a frame.
  useEffect(() => {
    let frame = 0,
      x = 0,
      y = 0;
    const update = () => {
      frame = 0;
      for (const el of els.current) {
        const r = el.getBoundingClientRect();
        const angle =
          (Math.atan2(y - (r.top + r.height / 2), x - (r.left + r.width / 2)) * 180) / Math.PI + 90;
        el.style.setProperty("--glass-x", `${x - r.left}px`);
        el.style.setProperty("--glass-y", `${y - r.top}px`);
        el.style.setProperty("--glass-angle", `${angle.toFixed(1)}deg`);
      }
    };
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Development builds let the probe count registered panels, to catch leaks.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __glassPanels?: () => number };
    w.__glassPanels = () => els.current.size;
    return () => {
      delete w.__glassPanels;
    };
  }, []);

  const value = useMemo<GlassContextValue>(
    () => ({
      settings,
      setSettings,
      systemReduce,
      reduce,
      refracting: refracting && !reduce,
      setRefracting,
      register: (el) => {
        els.current.add(el);
        return () => els.current.delete(el);
      },
      elements: () => els.current,
    }),
    [settings, setSettings, refracting, systemReduce, reduce],
  );
  return <GlassContext.Provider value={value}>{children}</GlassContext.Provider>;
}
