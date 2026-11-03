// 设置里的 AI (docs/05-design.md §5.4): what you have said yes to for good, to take back. Only
// you add to this list, by pressing 以后这类都允许 on a proposal; AI can neither change these
// settings nor propose to (CLAUDE.md). AI 接入 (§5.8) joins this section in P3.
import { allowRules, useAllowRules } from "../ai/proposals";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { SettingRow } from "./SettingRow";

export function AiSection() {
  const t = useT();
  const rules = useAllowRules();
  return (
    <>
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
