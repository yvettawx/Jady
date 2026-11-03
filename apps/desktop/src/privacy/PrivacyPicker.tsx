// The level beside a note's title, and the only way to change it: the user, here. AI can
// neither change it nor propose to (CLAUDE.md). Raising takes effect at once; lowering says who
// can read it then and asks first. With 普通 only a quiet lock shows, so the level can be set.
import { useState } from "react";
import { Button as AriaButton, MenuTrigger, Popover } from "react-aria-components";
import { useT } from "../i18n/context";
import { PrivacyMark, type PrivacyLevel } from "../ui/Badge";
import { ConfirmDialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { MenuList, type MenuEntry } from "../ui/Menu";
import { isLowering } from "./policy";
import "./privacy.css";

const LEVELS: PrivacyLevel[] = ["normal", "sensitive", "private", "secret"];

export function PrivacyPicker({
  level,
  verify,
  aiWeb,
  onLevel,
  onVerify,
  onAiWeb,
}: {
  level: PrivacyLevel;
  /** 机密 only: 打开前再验证. */
  verify?: boolean;
  onLevel: (level: PrivacyLevel) => void;
  onVerify?: (on: boolean) => void;
  /** 敏感 only: 可以联网给 AI 用 (format spec meta.ai_web). Only this control sets it. */
  aiWeb?: boolean;
  onAiWeb?: (on: boolean) => void;
}) {
  const t = useT();
  const [lowering, setLowering] = useState<PrivacyLevel | null>(null);
  const [allowingWeb, setAllowingWeb] = useState(false);
  const items: MenuEntry[] = [
    ...LEVELS.map((l): MenuEntry => ({
      id: l,
      label: t(`privacy.${l}`),
      icon: l === level ? "check" : l === "normal" ? undefined : "lock",
    })),
    ...(level === "secret" && onVerify
      ? ([
          { kind: "separator", id: "sep" },
          { id: "verify", label: t("privacy.verify"), icon: verify ? "check" : undefined },
        ] satisfies MenuEntry[])
      : []),
    ...(level === "sensitive" && onAiWeb
      ? ([
          { kind: "separator", id: "sep" },
          { id: "ai-web", label: t("privacy.aiWeb"), icon: aiWeb ? "check" : "web" },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    <>
      <MenuTrigger>
        <AriaButton className="dem-privacy-picker" aria-label={t("privacy.level")}>
          {level === "normal" ? <Icon name="lock" size={12} /> : <PrivacyMark level={level} />}
          {level === "sensitive" && aiWeb && (
            <span className="dem-privacy-web" title={t("privacy.aiWeb")}>
              <Icon name="web" size={12} />
            </span>
          )}
        </AriaButton>
        <Popover className="dem-popover dem-menu-popover" placement="bottom start" offset={4}>
          <MenuList
            aria-label={t("privacy.level")}
            items={items}
            onAction={(k) => {
              const id = String(k);
              if (id === "verify") onVerify?.(!verify);
              // Allowing asks first; taking it back happens at once.
              else if (id === "ai-web") {
                if (aiWeb) onAiWeb?.(false);
                else setAllowingWeb(true);
              } else if (id !== level) {
                if (isLowering(level, id as PrivacyLevel)) setLowering(id as PrivacyLevel);
                else onLevel(id as PrivacyLevel);
              }
            }}
          />
        </Popover>
      </MenuTrigger>
      <ConfirmDialog
        isOpen={allowingWeb}
        onOpenChange={setAllowingWeb}
        title={t("privacy.aiWeb.title")}
        message={t("privacy.aiWeb.message")}
        confirmLabel={t("privacy.aiWeb.confirm")}
        onConfirm={() => {
          onAiWeb?.(true);
          setAllowingWeb(false);
        }}
      />
      <ConfirmDialog
        isOpen={lowering !== null}
        onOpenChange={(open) => !open && setLowering(null)}
        title={t("privacy.lower.title", { level: lowering ? t(`privacy.${lowering}`) : "" })}
        message={lowering ? t(`privacy.lower.${lowering}`) : ""}
        confirmLabel={t("privacy.lower.confirm", {
          level: lowering ? t(`privacy.${lowering}`) : "",
        })}
        onConfirm={() => {
          if (lowering) onLevel(lowering);
          setLowering(null);
        }}
      />
    </>
  );
}
