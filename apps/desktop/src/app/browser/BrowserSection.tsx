// 设置 › 专用浏览器 (D11, D15): whether AI may use it, and on which sites. Only you change these,
// here; AI can neither change them nor propose to (CLAUDE.md).
import { useState } from "react";
import { useT } from "../../i18n/context";
import { SettingRow } from "../../settings/SettingRow";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { failed } from "../actions";
import { api } from "../api";
import { useLive } from "../live";
import "./browser.css";

export function BrowserSection() {
  const t = useT();
  const [seq, setSeq] = useState(0);
  const { data: settings } = useLive(() => api.browserSettings(), null, [seq]);
  const { data: status } = useLive(() => api.browserStatus(), null, [seq]);
  // What you are typing, until the field loses focus and it is saved.
  const [draft, setDraft] = useState<string | null>(null);
  if (!settings || !status) return null;
  const save = (patch: Partial<typeof settings>) =>
    void api
      .browserSettingsSet({ ...settings, ...patch })
      .then(() => setSeq((n) => n + 1))
      .catch(failed(t, t("settings.browser.use")));
  const saved = (settings.sites ?? []).join("\n");
  const list = (text: string) =>
    text
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <>
      <SettingRow
        label={t("settings.browser.use")}
        hint={status.chrome ? t("settings.browser.use.hint") : t("settings.browser.noChrome")}
      >
        <Switch
          aria-label={t("settings.browser.use")}
          isSelected={settings.enabled}
          isDisabled={!status.chrome}
          onChange={(on) => save({ enabled: on })}
        >
          {null}
        </Switch>
      </SettingRow>
      <SettingRow label={t("settings.browser.sites")} hint={t("settings.browser.sites.hint")} wide>
        <textarea
          className="dem-browser-sites"
          aria-label={t("settings.browser.sites")}
          placeholder={t("settings.browser.sites.placeholder")}
          spellCheck={false}
          value={draft ?? saved}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && list(draft).join("\n") !== saved) save({ sites: list(draft) });
            setDraft(null);
          }}
        />
      </SettingRow>
      <SettingRow label={t("settings.browser.signIn")} hint={t("settings.browser.signIn.hint")}>
        <Button
          size="sm"
          icon="web"
          isDisabled={!status.chrome}
          onPress={() =>
            void api
              .browserShow()
              .then(() => setSeq((n) => n + 1))
              .catch(failed(t, t("settings.browser.signIn")))
          }
        >
          {t("settings.browser.open")}
        </Button>
      </SettingRow>
    </>
  );
}
