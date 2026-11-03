// The colour mode in effect: data-theme on <html> when set, otherwise the system setting.
import { useSyncExternalStore } from "react";
import type { Mode } from "./tokens.ts";

// matchMedia is missing in some test environments; treat that as light.
const media = (): MediaQueryList | undefined => window.matchMedia?.("(prefers-color-scheme: dark)");

export function currentMode(): Mode {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return media()?.matches ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const mq = media();
  mq?.addEventListener("change", onChange);
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    mq?.removeEventListener("change", onChange);
    mo.disconnect();
  };
}

export function useColorMode(): Mode {
  return useSyncExternalStore(subscribe, currentMode, () => "light");
}
