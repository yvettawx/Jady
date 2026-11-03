// 新手引导 (H8): language, AI and what to start with, the first time a library is opened. Everything
// here is the same control the settings have, and every step can be skipped.
import { useEffect, useState } from "react";
import { useT } from "../../i18n/context";
import type { Locale } from "../../i18n/messages";
import { setAppearance, useAppearance } from "../../settings/appearance";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
import { api } from "../api";
import { AiSettingsSection } from "../panels/AiSettingsSection";
import { TemplatesSection } from "./LifeView";

const WELCOMED = "ui-welcomed";
export const TIPS_CLOSED = "ui-tips-closed";
const STEPS = ["language", "ai", "templates"] as const;

export function Welcome() {
  const t = useT();
  const a = useAppearance();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  useEffect(() => {
    let alive = true;
    // A library that already has things in it needs no introduction.
    void Promise.all([
      api.localGet(WELCOMED),
      api.itemList({
        typeId: null,
        states: null,
        container: null,
        tag: null,
        order: null,
        limit: 2,
      }),
    ]).then(([seen, some]) => {
      // A new library holds just the page that says how things work.
      if (alive && !seen && some.length < 2) setOpen(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const finish = () => {
    setOpen(false);
    void api.localSet(WELCOMED, "1");
  };
  const name = STEPS[step] ?? "language";
  return (
    <Dialog
      title={t(`welcome.${name}`)}
      isOpen={open}
      isDismissable={false}
      onOpenChange={(o) => {
        if (!o) finish();
      }}
    >
      <div className="dem-welcome">
        <p>{t(`welcome.${name}.about`)}</p>
        {name === "language" && (
          <Select
            aria-label={t("settings.language")}
            selectedKey={a.locale}
            onSelectionChange={(k) => setAppearance({ locale: k as Locale })}
            options={[
              { id: "zh-CN", label: t("settings.language.zh-CN") },
              { id: "en", label: t("settings.language.en") },
            ]}
          />
        )}
        {name === "ai" && <AiSettingsSection />}
        {name === "templates" && <TemplatesSection />}
      </div>
      <div className="dem-welcome-foot">
        <span className="dem-nav-count">{`${step + 1}/${STEPS.length}`}</span>
        <span className="dem-life-gap" />
        <Button variant="quiet" onPress={finish}>
          {t("welcome.skip")}
        </Button>
        {step + 1 < STEPS.length ? (
          <Button variant="primary" onPress={() => setStep(step + 1)}>
            {t("action.next")}
          </Button>
        ) : (
          <Button variant="primary" onPress={finish}>
            {t("welcome.start")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}

/** On the home page until closed: the few things worth knowing on day one. */
export function TipsWidget() {
  const t = useT();
  const [closed, setClosed] = useState<boolean | null>(null);
  useEffect(() => {
    void api.localGet(TIPS_CLOSED).then((v) => setClosed(!!v));
  }, []);
  if (closed !== false) return null;
  return (
    <div className="dem-tips">
      <ul>
        {["search", "capture", "settings", "ai"].map((k) => (
          <li key={k}>{t(`tips.${k}`)}</li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="quiet"
        onPress={() => {
          setClosed(true);
          void api.localSet(TIPS_CLOSED, "1");
        }}
      >
        {t("tips.close")}
      </Button>
    </div>
  );
}
