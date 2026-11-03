// 隐私层级 as a launcher command for the user. It changes a setting of the item, so it is marked:
// AI is never offered it, not even as a proposal (CLAUDE.md, docs/05-design.md §5.7).
import { registerCommand } from "../shell/commands";
import type { PrivacyLevel } from "../ui/Badge";

export const PRIVACY_LEVELS: PrivacyLevel[] = ["normal", "sensitive", "private", "secret"];

export function registerPrivacyCommand(
  t: (key: string) => string,
  run: () => void,
  setLevel: (level: PrivacyLevel) => void,
): () => void {
  return registerCommand({
    id: "privacy.setLevel",
    title: t("privacy.level"),
    icon: "lock",
    changesSettings: true,
    run,
    options: () => PRIVACY_LEVELS.map((id) => ({ id, label: t(`privacy.${id}`) })),
    runWith: (id) => setLevel(id as PrivacyLevel),
  });
}
