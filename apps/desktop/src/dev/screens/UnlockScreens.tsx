// Review page for P0.5-07-4, development builds only: #/screens/unlock?step=…
// A fake LibraryGate stands in for the core: master password "correct horse", keychain slow
// with ?slow, any complete recovery code except one starting with "0000" is accepted.
import { useState } from "react";
import { useColorMode } from "../../theme/mode.ts";
import { SCHEMES } from "../../theme/tokens.ts";
import { Button } from "../../ui/Button";
import { GlassBackdrop } from "../../ui/glass/GlassBackdrop";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { useWallpaper } from "../../ui/glass/wallpaper";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { TitleBar } from "../../shell/TitleBar";
import type { LibraryGate } from "../../screens/unlock/gate";
import {
  LibraryGateScreen,
  type GateStart,
  type GateStep,
} from "../../screens/unlock/LibraryGateScreen";
import "../lab.css";
import "./screens.css";

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LIB = { name: "我的资料库", path: "~/Documents/Jady/我的资料库" };

const PENDING = {
  recoveryCode: "7K3MQ9TBXH2PWD5RNE8C4VJAFG6YSZ1T0M3Q",
  commit: () => wait(900),
  cancel: () => {},
};

const fakeGate: LibraryGate = {
  defaultLocation: () => "~/Documents/Jady",
  chooseFolder: async () => (await wait(300), "~/Library/Mobile Documents/资料库"),
  prepare: async () => (await wait(400), PENDING),
  exportRecoveryCode: async (_code, how) => {
    showToast({ text: how === "file" ? "（开发版）存成文件" : "（开发版）打印" });
  },
  keychainUnlock: async () => (
    await wait(params.has("slow") ? 3000 : 800),
    params.has("slow") ? "unavailable" : "ok"
  ),
  unlock: async (_lib, pw) => (await wait(600), pw === "correct horse" ? "ok" : "wrong"),
  recover: async (_lib, code) => (await wait(600), code.startsWith("0000") ? "bad-code" : "ok"),
};

const STEPS: GateStep[] = [
  "welcome",
  "location",
  "password",
  "recovery",
  "confirm",
  "creating",
  "unlocking",
  "unlock",
  "recover",
  "missing",
  "broken",
];

function startFor(step: GateStep): GateStart {
  if (step === "missing") return { mode: "missing", library: LIB };
  if (step === "broken")
    return {
      mode: "broken",
      library: LIB,
      details:
        "manifest.dexm: authentication failed (tag mismatch)\nitems/01J…/doc.dexd: unreadable",
    };
  if (["unlocking", "unlock", "recover"].includes(step)) return { mode: "unlock", library: LIB };
  return { mode: "first-run" };
}

function Page() {
  const mode = useColorMode();
  const wallpaper = useWallpaper(mode, SCHEMES.aurora[0]);
  const [step, setStep] = useState<GateStep>((params.get("step") as GateStep) ?? "welcome");
  const [opened, setOpened] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  return (
    <div className="lab">
      <GlassBackdrop source={wallpaper} accent={SCHEMES.aurora[0][0]} />
      <TitleBar />
      <main className="screen-center" key={`${step}-${run}`}>
        {opened ? (
          <p className="lab-quiet">已打开：{opened}</p>
        ) : (
          <LibraryGateScreen
            gate={fakeGate}
            start={startFor(step)}
            initialStep={step}
            initialPending={step === "recovery" || step === "confirm" ? PENDING : undefined}
            onOpened={(lib) => setOpened(lib.path)}
          />
        )}
      </main>
      <nav className="screen-steps" aria-label="步骤">
        {STEPS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === step ? "primary" : "quiet"}
            onPress={() => {
              setOpened(null);
              setStep(s);
              setRun((n) => n + 1);
              history.replaceState(
                null,
                "",
                `#/screens/unlock?step=${s}${params.has("slow") ? "&slow" : ""}`,
              );
            }}
          >
            {s}
          </Button>
        ))}
        <Button
          size="sm"
          variant="quiet"
          onPress={() =>
            (document.documentElement.dataset.theme = mode === "dark" ? "light" : "dark")
          }
        >
          {mode === "dark" ? "浅色" : "深色"}
        </Button>
      </nav>
      <ToastRegion />
    </div>
  );
}

export function UnlockScreens() {
  return (
    <GlassProvider accent={SCHEMES.aurora[0][0]}>
      <Page />
    </GlassProvider>
  );
}
