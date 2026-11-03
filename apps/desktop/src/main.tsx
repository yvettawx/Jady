import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { commands } from "./bindings";
import { AppearanceRoot } from "./settings/AppearanceRoot";
import { WindowBackground } from "./shell/WindowBackground";
import "./styles/theme.css";
import "./styles/fonts.css";

if (import.meta.env.DEV) void import("./styles/fonts-dev.css");

// Development-only pages (docs/plans/p0.5.md, P0.5-06): #/sample, #/glass, #/workspace, #/titlebar.
const DEV_PAGES = import.meta.env.DEV
  ? {
      "#/sample": lazy(() => import("./dev/SampleRoom").then((m) => ({ default: m.SampleRoom }))),
      "#/glass": lazy(() => import("./dev/GlassLab").then((m) => ({ default: m.GlassLab }))),
      "#/screens/unlock": lazy(() =>
        import("./dev/screens/UnlockScreens").then((m) => ({ default: m.UnlockScreens })),
      ),
      "#/screens/shell": lazy(() =>
        import("./dev/screens/ShellScreens").then((m) => ({ default: m.ShellScreens })),
      ),
      "#/screens/board": lazy(() =>
        import("./dev/screens/BoardScreens").then((m) => ({ default: m.BoardScreens })),
      ),
      "#/screens/editor": lazy(() =>
        import("./dev/screens/EditorScreens").then((m) => ({ default: m.EditorScreens })),
      ),
      "#/screens/ai": lazy(() =>
        import("./dev/screens/AiScreens").then((m) => ({ default: m.AiScreens })),
      ),
      "#/screens/heatmap": lazy(() =>
        import("./dev/screens/HeatmapScreens").then((m) => ({ default: m.HeatmapScreens })),
      ),
      "#/screens/privacy": lazy(() =>
        import("./dev/screens/PrivacyScreens").then((m) => ({ default: m.PrivacyScreens })),
      ),
      "#/screens/settings": lazy(() =>
        import("./dev/screens/ShellScreens").then((m) => ({ default: m.ShellScreens })),
      ),
      "#/screens/launcher": lazy(() =>
        import("./dev/screens/ShellScreens").then((m) => ({ default: m.ShellScreens })),
      ),
      "#/screens/capture": lazy(() =>
        import("./dev/screens/CaptureScreens").then((m) => ({ default: m.CaptureScreens })),
      ),
      "#/screens/home": lazy(() =>
        import("./dev/screens/ShellScreens").then((m) => ({ default: m.ShellScreens })),
      ),
      "#/titlebar": lazy(() =>
        import("./dev/TitleBarLab").then((m) => ({ default: m.TitleBarLab })),
      ),
      "#/workspace": lazy(() =>
        import("./dev/WorkspaceLab").then((m) => ({ default: m.WorkspaceLab })),
      ),
    }
  : null;
const inTauri = "__TAURI_INTERNALS__" in window;
const DevPage =
  DEV_PAGES?.[location.hash.split("?")[0] as keyof typeof DEV_PAGES] ??
  // A development build in a plain browser cannot run the app; list the pages instead.
  (import.meta.env.DEV && !inTauri
    ? lazy(() => import("./dev/DevIndex").then((m) => ({ default: m.DevIndex })))
    : undefined);

if (inTauri) {
  // What goes wrong in the interface ends up in the local log, not only in a console nobody sees.
  addEventListener("error", (e) => void commands.diag(`error: ${e.message}`));
  addEventListener(
    "unhandledrejection",
    (e) => void commands.diag(`rejected: ${String(e.reason)}`),
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <WindowBackground />
      {DevPage ? (
        // React Aria's own strings (drag and drop, "Dismiss") follow the interface language,
        // not the browser's.
        <AppearanceRoot>
          <Suspense>
            <DevPage />
          </Suspense>
        </AppearanceRoot>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
}
