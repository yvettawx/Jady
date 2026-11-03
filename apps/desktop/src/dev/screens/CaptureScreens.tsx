// Review page for the global capture window (P0.5-07-7), development builds only:
// #/screens/capture. A stand-in desktop with the small window on it; the real separate window
// and its global shortcut (⌥⌘N) come in P1.
import { useState } from "react";
import { CaptureWindow } from "../../launcher/CaptureWindow";
import { SCHEMES } from "../../theme/tokens.ts";
import { useColorMode } from "../../theme/mode.ts";
import { GlassBackdrop } from "../../ui/glass/GlassBackdrop";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { useWallpaper } from "../../ui/glass/wallpaper";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { DEMO_TYPES } from "./launcherDemo";
import "../lab.css";
import "./screens.css";

function Page() {
  const mode = useColorMode();
  const wallpaper = useWallpaper(mode, SCHEMES.aurora[2]);
  const [open, setOpen] = useState(true);
  return (
    <div className="lab">
      <GlassBackdrop source={wallpaper} accent={SCHEMES.aurora[2][0]} />
      <main className="screen-capture">
        {open ? (
          <CaptureWindow
            types={DEMO_TYPES}
            onCapture={(type, text) =>
              showToast({
                text: type
                  ? `（开发版）已新建${type.name}：${text}`
                  : `（开发版）已放进收集箱：${text}`,
              })
            }
            onClose={() => setOpen(false)}
          />
        ) : (
          <button type="button" className="screen-capture-reopen" onClick={() => setOpen(true)}>
            ⌥⌘N
          </button>
        )}
      </main>
      <ToastRegion />
    </div>
  );
}

export function CaptureScreens() {
  return (
    <GlassProvider accent={SCHEMES.aurora[2][0]}>
      <Page />
    </GlassProvider>
  );
}
