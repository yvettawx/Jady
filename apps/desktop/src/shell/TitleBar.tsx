// The self-drawn title bar (docs/05-design.md §2.1). macOS keeps its own traffic lights in an
// overlay title bar (tauri.macos.conf.json); we leave room for them. On Windows the caption
// buttons come from tauri-plugin-frame (it keeps the Windows 11 snap layout flyout), so the
// right edge is left free. Everything not interactive is a drag region; buttons are not.
import { useEffect, useState, type ReactNode } from "react";
import { currentPlatform, inTauri } from "./platform";
import "./titlebar.css";

function useFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const sync = () =>
        w.isFullscreen().then(
          (f) => alive && setFull(f),
          () => {},
        );
      await sync();
      off = await w.onResized(sync);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return full;
}

export function TitleBar({ children }: { children?: ReactNode }) {
  const platform = currentPlatform();
  const fullscreen = useFullscreen();
  return (
    <header
      className="dem-titlebar"
      data-platform={platform}
      data-fullscreen={fullscreen || undefined}
      data-tauri-drag-region
    >
      <div className="dem-titlebar-lead" data-tauri-drag-region />
      <div className="dem-titlebar-content" data-tauri-drag-region>
        {children}
      </div>
      <div className="dem-titlebar-trail" data-tauri-drag-region />
    </header>
  );
}
