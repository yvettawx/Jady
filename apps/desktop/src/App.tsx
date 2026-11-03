// The whole app: 全局收集's window, or the gate and then the workbench.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { commands } from "./bindings";
import { api, CoreFailure, itemsChanged, listenForChanges } from "./app/api";
import { flushNotes } from "./app/active";
import { CaptureApp } from "./app/CaptureApp";
import { newItem } from "./app/actions";
import { realGate } from "./app/gate";
import { Workbench } from "./app/Workbench";
import { useT } from "./i18n/context";
import { LibraryGateScreen, type GateStart } from "./screens/unlock/LibraryGateScreen";
import type { LibraryRef } from "./screens/unlock/gate";
import { AppearanceRoot } from "./settings/AppearanceRoot";
import { useAppearance } from "./settings/appearance";
import { TitleBar } from "./shell/TitleBar";
import { SCHEMES } from "./theme/tokens.ts";
import { useColorMode } from "./theme/mode.ts";
import { GlassBackdrop } from "./ui/glass/GlassBackdrop";
import { GlassProvider } from "./ui/glass/GlassProvider";
import { useWallpaper } from "./ui/glass/wallpaper";
import { ToastRegion } from "./ui/Toasts";
import "./app/app.css";

interface Boot {
  start: GateStart;
  defaultLocation: string;
}

async function boot(locked = false): Promise<Boot | "open"> {
  if (await commands.libraryIsOpen()) return "open";
  const s = await commands.libraryStart();
  const library = s.library;
  const start: GateStart =
    s.mode === "unlock" && library
      ? { mode: "unlock", library, locked }
      : s.mode === "missing" && library
        ? { mode: "missing", library }
        : s.mode === "broken" && library
          ? { mode: "broken", library, details: s.details ?? "" }
          : { mode: "first-run" };
  return { start, defaultLocation: s.defaultLocation };
}

function Gate({ boot: b, onOpen }: { boot: Boot; onOpen: () => void }) {
  const t = useT();
  const appearance = useAppearance();
  const mode = useColorMode();
  const colors = SCHEMES[appearance.scheme][0] ?? SCHEMES.aurora[0];
  const wallpaper = useWallpaper(mode, colors);
  const [start, setStart] = useState(b.start);
  const [seq, setSeq] = useState(0);
  const onOpened = (lib: LibraryRef) => {
    void api.libraryIsOpen().then(async (isOpen) => {
      if (isOpen) {
        // A library just made starts with a page that says how things work.
        if (start.mode === "first-run") {
          await api.itemCreate(
            newItem({
              typeId: "note",
              title: t("welcome.title"),
              markdown: t("welcome.body"),
            }),
          );
          itemsChanged();
        }
        onOpen();
        return;
      }
      // An existing library was picked on the welcome screen: it still has to be unlocked.
      try {
        const library = await api.libraryAdopt(lib.path);
        setStart({ mode: "unlock", library });
        setSeq((n) => n + 1);
      } catch (e) {
        setStart({
          mode: "broken",
          library: lib,
          details: e instanceof CoreFailure ? e.message : String(e),
        });
        setSeq((n) => n + 1);
      }
    });
  };
  return (
    <GlassProvider
      accent={colors[0]}
      settings={appearance.glass}
      onSettingsChange={() => undefined}
    >
      <GlassBackdrop source={wallpaper} accent={colors[0]} />
      <TitleBar />
      <main className="dem-gate-page">
        <LibraryGateScreen
          key={seq}
          gate={realGate(b.defaultLocation, t)}
          start={start}
          onOpened={onOpened}
        />
      </main>
    </GlassProvider>
  );
}

function Main() {
  const [state, setState] = useState<Boot | "open" | null>(null);
  useEffect(() => {
    listenForChanges();
    // ⌘Q comes from the menu as an event (src-tauri/src/quit.rs).
    void listen("quit-requested", () => {
      void flushNotes().finally(() => void getCurrentWindow().destroy());
    });
    void boot().then(
      (b) => {
        setState(b);
        void commands.diag(`interface up: ${b === "open" ? "open" : b.start.mode}`);
      },
      (e: unknown) => void commands.diag(`boot failed: ${String(e)}`),
    );
  }, []);
  const onLock = useCallback(() => {
    void flushNotes()
      .then(() => api.libraryLock())
      .then(() => boot(true))
      .then(setState);
  }, []);
  if (!state) return null;
  return (
    <>
      {state === "open" ? (
        <Workbench onLock={onLock} />
      ) : (
        <Gate boot={state} onOpen={() => setState("open")} />
      )}
      <ToastRegion />
    </>
  );
}

export function App() {
  const capture = location.hash.startsWith("#/capture");
  return <AppearanceRoot>{capture ? <CaptureApp /> : <Main />}</AppearanceRoot>;
}
