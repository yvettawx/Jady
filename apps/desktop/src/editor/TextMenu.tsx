// The right-click menu on selected text (docs/05-design.md §6.2, §5.6): 问 AI, 翻译, 生成记忆卡,
// 互联网搜索, 复制, 剪切. What each privacy level allows comes from policy: AI and web search are
// greyed with the reason, and web search on 敏感 content asks first.
import { useState, type ReactNode } from "react";
import { useT } from "../i18n/context";
import { webSearch } from "../privacy/policy";
import { aiBlockedReason } from "../privacy/text";
import type { PrivacyLevel } from "../ui/Badge";
import { ConfirmDialog } from "../ui/Dialog";
import { ContextMenu, type MenuEntry } from "../ui/Menu";

export type TextAction = "ask-ai" | "translate" | "card" | "web-search" | "copy" | "cut";

export function TextMenu({
  privacy,
  ai = true,
  onAction,
  children,
}: {
  privacy: PrivacyLevel;
  /** Off while there is no AI: 问 AI, 翻译 and 生成记忆卡 do not show. */
  ai?: boolean;
  onAction: (a: TextAction) => void;
  children: ReactNode;
}) {
  const t = useT();
  const [confirmWeb, setConfirmWeb] = useState(false);
  const blocked = aiBlockedReason(t, privacy);
  const web = webSearch(privacy);
  return (
    <>
      <ContextMenu
        aria-label={t("menu.text")}
        items={[
          ...(ai
            ? ([
                {
                  id: "ask-ai",
                  label: t("menu.askAi"),
                  icon: "ai",
                  isDisabled: !!blocked,
                  note: blocked,
                },
                { id: "translate", label: t("menu.translate"), icon: "translate" },
                { id: "card", label: t("menu.toCard"), icon: "card" },
              ] satisfies MenuEntry[])
            : []),
          {
            id: "web-search",
            label: t("menu.webSearch"),
            icon: "search",
            isDisabled: web === "blocked",
            note: web === "blocked" ? t("menu.webBlocked") : undefined,
          },
          { kind: "separator", id: "sep" },
          { id: "copy", label: t("menu.copy"), icon: "copy", shortcut: "Mod+C" },
          { id: "cut", label: t("menu.cut"), shortcut: "Mod+X" },
        ]}
        onAction={(k) => {
          const a = String(k) as TextAction;
          if (a === "web-search" && web === "confirm") setConfirmWeb(true);
          else onAction(a);
        }}
      >
        {children}
      </ContextMenu>
      <ConfirmDialog
        isOpen={confirmWeb}
        onOpenChange={setConfirmWeb}
        title={t("privacy.web.title")}
        message={t("privacy.web.message")}
        confirmLabel={t("privacy.web.confirm")}
        onConfirm={() => {
          onAction("web-search");
          setConfirmWeb(false);
        }}
      />
    </>
  );
}
