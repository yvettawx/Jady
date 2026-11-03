// While the window is being resized, WKWebView lays the page out a couple of frames late, and
// the strip it has not drawn yet shows the window's own background. Painting that background
// in the wallpaper's base colour, per light or dark, keeps the edge from flashing white.
import { useEffect } from "react";
import { useColorMode } from "../theme/mode.ts";
import { MODES } from "../theme/tokens.ts";
import { inTauri } from "./platform";

export function WindowBackground() {
  const mode = useColorMode();
  useEffect(() => {
    if (!inTauri()) return;
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow()
        .setBackgroundColor(MODES[mode].canvas)
        .catch(() => {}),
    );
  }, [mode]);
  return null;
}
