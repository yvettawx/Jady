// The system's 减少透明度 setting (docs/05-design.md B.2). In the app it comes from the shell,
// asked again whenever the window regains focus (that is when a change made in System Settings
// can have happened). In a plain browser it comes from the media query, where supported.
import { useEffect, useState } from "react";
import { commands } from "../bindings";

const inTauri = () => "__TAURI_INTERNALS__" in window;
const QUERY = "(prefers-reduced-transparency: reduce)";

export function useSystemReduceTransparency(): boolean {
  const [on, setOn] = useState(() => (!inTauri() && window.matchMedia?.(QUERY).matches) || false);
  useEffect(() => {
    if (!inTauri()) {
      const mq = window.matchMedia?.(QUERY);
      const sync = () => setOn(!!mq?.matches);
      mq?.addEventListener("change", sync);
      return () => mq?.removeEventListener("change", sync);
    }
    let alive = true;
    const ask = () =>
      commands.systemAppearance().then(
        (a) => alive && setOn(a.reduceTransparency),
        () => {},
      );
    const onVisible = () => document.visibilityState === "visible" && ask();
    ask();
    window.addEventListener("focus", ask);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.removeEventListener("focus", ask);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return on;
}

const MOTION = "(prefers-reduced-motion: reduce)";

/** The system's 减少动效 setting; WebKit and WebView2 both report it through the media query. */
export function useReducedMotion(): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.(MOTION).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(MOTION);
    const sync = () => setOn(!!mq?.matches);
    mq?.addEventListener("change", sync);
    return () => mq?.removeEventListener("change", sync);
  }, []);
  return on;
}
