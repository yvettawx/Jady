// 设置 › AI (docs/05-design.md §5.8): which way to reach AI, and what you have said yes to for good.
// Only you change these, here. AI can neither change them nor propose to (CLAUDE.md).
import { useState } from "react";
import { allowRules, useAllowRules } from "../../ai/proposals";
import type { AiSettings } from "../../bindings";
import { useT } from "../../i18n/context";
import { SettingRow } from "../../settings/SettingRow";
import { Button } from "../../ui/Button";
import { PasswordField } from "../../ui/PasswordField";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import { useSettingsWorkspace } from "./settingsWorkspace";
import { failed, newItem, openItem } from "../actions";
import { api, itemsChanged } from "../api";
import { useLive } from "../live";
import { library } from "../store";

/** The ways that ship with the app; a plugin's own show by id after them. */
const BUILTIN = ["claude-code", "codex", "api-key", "openai-compatible"] as const;

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

export function AiSettingsSection() {
  const t = useT();
  const rules = useAllowRules();
  const workspace = useSettingsWorkspace();
  const [seq, setSeq] = useState(0);
  const { data: status } = useLive(() => api.aiStatus(), null, [seq]);
  const [key, setKey] = useState("");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  if (!status) return null;
  const save = (patch: Partial<AiSettings>) =>
    void api
      .aiSettingsSet({ ...status.settings, ...patch })
      .then(() => setSeq((n) => n + 1))
      .catch(failed(t, t("settings.ai.connect")));
  const info = (id: string) => status.providers.find((p) => p.id === id);
  const others = status.providers.filter((p) => !(BUILTIN as readonly string[]).includes(p.id));
  const chosen = status.settings.provider ?? status.current ?? "claude-code";
  const current = info(chosen);
  // Codex and the compatible endpoint take any model name; the other two pick a Claude model.
  const freeModel = chosen === "codex" || chosen === "openai-compatible";
  const program = chosen === "claude-code" ? "claude" : "codex login";
  const typedEndpoint = endpoint ?? status.settings.endpoint ?? "";
  const endpointOk =
    typedEndpoint.trim() === "" || /^https?:\/\/[^\s/]+\S*$/.test(typedEndpoint.trim());
  const saveKey = (value: string | null) =>
    void api
      .aiKeySet(chosen, value)
      .then(() => {
        setKey("");
        setSeq((n) => n + 1);
        if (value) showToast({ text: t("settings.ai.keySaved"), tone: "ok" });
      })
      .catch(failed(t, t("settings.ai.apiKey")));
  const agreement = () => {
    const have = library().items.find((i) => i.typeId === "agreement" && !i.container);
    void (async () => {
      const item =
        have ??
        (await api.itemCreate(
          newItem({
            typeId: "agreement",
            title: t("agreement.global"),
            markdown: t("agreement.default"),
          }),
        ));
      itemsChanged();
      if (workspace) openItem(workspace, t, item, { kind: "temp" });
    })().catch(failed(t, t("settings.ai.agreement")));
  };
  return (
    <>
      <SettingRow label={t("settings.ai.connect")} hint={t(`settings.ai.connect.${chosen}.hint`)}>
        <Select
          aria-label={t("settings.ai.connect")}
          options={[
            ...BUILTIN.map((id) => ({ id, label: t(`settings.ai.provider.${id}`) })),
            ...others.map((p) => ({ id: p.id, label: p.id })),
          ]}
          selectedKey={chosen}
          onSelectionChange={(id) => {
            if (String(id) === chosen) return;
            setModel(null);
            save({ provider: String(id), model: null });
          }}
        />
      </SettingRow>
      {(chosen === "claude-code" || chosen === "codex") && (
        <SettingRow
          label={t("settings.ai.status")}
          hint={
            !current?.available
              ? t("settings.ai.programMissing", { program: t(`settings.ai.program.${chosen}`) })
              : current.ready
                ? current.detail
                : t("settings.ai.programLogin", { command: program })
          }
        >
          <span className="dem-setting-value">
            {t(current?.ready ? "settings.ai.ready" : "settings.ai.notReady")}
          </span>
        </SettingRow>
      )}
      {chosen === "openai-compatible" && (
        <SettingRow label={t("settings.ai.endpoint")} hint={t("settings.ai.endpoint.hint")} wide>
          <TextField
            aria-label={t("settings.ai.endpoint")}
            value={typedEndpoint}
            onChange={setEndpoint}
            isInvalid={!endpointOk}
            errorMessage={t("settings.ai.endpoint.invalid")}
            onBlur={() => {
              if (endpoint === null || !endpointOk) return;
              save({ endpoint: endpoint.trim() || null });
              setEndpoint(null);
            }}
          />
        </SettingRow>
      )}
      {chosen === "claude-code" && (
        <SettingRow label={t("settings.ai.isolate")} hint={t("settings.ai.isolate.hint")}>
          <Switch
            aria-label={t("settings.ai.isolate")}
            isSelected={status.settings.isolate}
            onChange={(on) => save({ isolate: on })}
          >
            {null}
          </Switch>
        </SettingRow>
      )}
      {(chosen === "api-key" || chosen === "openai-compatible") && (
        <SettingRow
          label={t("settings.ai.apiKey")}
          hint={t(
            current?.keySaved
              ? "settings.ai.keySaved"
              : chosen === "openai-compatible"
                ? "settings.ai.keyOptional"
                : "settings.ai.keyHint",
          )}
          wide
        >
          <div className="dem-ai-key">
            <PasswordField label={t("settings.ai.apiKey")} value={key} onChange={setKey} />
            <Button size="sm" isDisabled={!key.trim()} onPress={() => saveKey(key.trim())}>
              {t("action.save")}
            </Button>
            {current?.keySaved && (
              <Button size="sm" variant="quiet" onPress={() => saveKey(null)}>
                {t("settings.ai.keyRemove")}
              </Button>
            )}
          </div>
        </SettingRow>
      )}
      <SettingRow
        label={t("settings.ai.model")}
        hint={chosen === "codex" ? t("settings.ai.model.codex") : undefined}
      >
        {freeModel ? (
          <TextField
            aria-label={t("settings.ai.model")}
            value={model ?? status.settings.model ?? ""}
            onChange={setModel}
            onBlur={() => {
              if (model === null) return;
              save({ model: model.trim() || null });
              setModel(null);
            }}
          />
        ) : (
          <Select
            aria-label={t("settings.ai.model")}
            options={MODELS}
            selectedKey={status.settings.model ?? MODELS[0]?.id ?? ""}
            onSelectionChange={(k) => save({ model: String(k) })}
          />
        )}
      </SettingRow>
      <SettingRow label={t("settings.ai.agreement")} hint={t("settings.ai.agreement.hint")}>
        <Button size="sm" icon="edit" onPress={agreement}>
          {t("settings.ai.agreement.edit")}
        </Button>
      </SettingRow>
      <h3 className="dem-settings-sub">{t("settings.ai.rules")}</h3>
      {rules.length === 0 && <p className="dem-settings-empty">{t("settings.ai.none")}</p>}
      {rules.map((r) => (
        <SettingRow
          key={r.id}
          label={t("ai.rule", { action: t(`ai.action.${r.action}`), scope: r.scope.label })}
          keywords={t("settings.keywords.ai").split(" ")}
        >
          <Button size="sm" variant="quiet" onPress={() => allowRules.remove(r.id)}>
            {t("settings.ai.revoke")}
          </Button>
        </SettingRow>
      ))}
    </>
  );
}
