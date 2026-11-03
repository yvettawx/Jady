// The small bar that floats beside selected text (docs/05-design.md §6.1, §6.2): marks, a link,
// 生成记忆卡 and 问 AI. It follows the selection, and Esc puts it away until the selection
// changes. It sits over the text, so its glass uses CSS blur (B.2).
import { useEffect, useState, type RefObject } from "react";
import { Button as AriaButton } from "react-aria-components";
import { useT } from "../i18n/context";
import { aiBlockedReason } from "../privacy/text";
import type { PrivacyLevel } from "../ui/Badge";
import { Glass } from "../ui/glass/Glass";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { Tooltip } from "../ui/Tooltip";
import type { FormatCommand } from "./NoteSheet";
import "./selbar.css";

export type SelectionAction = FormatCommand | "card" | "ask-ai";

const ITEMS: { id: SelectionAction; icon: IconName; label: string; shortcut?: string }[] = [
  { id: "bold", icon: "bold", label: "editor.fmt.bold", shortcut: "Mod+B" },
  { id: "italic", icon: "italic", label: "editor.fmt.italic", shortcut: "Mod+I" },
  { id: "highlight", icon: "highlight", label: "editor.fmt.highlight" },
  { id: "link", icon: "link", label: "editor.fmt.link" },
];

export function SelectionBar({
  root,
  disabled,
  privacy = "normal",
  ai = true,
  onAction,
}: {
  /** Only selections inside this element count. */
  root: RefObject<HTMLElement | null>;
  disabled?: boolean;
  privacy?: PrivacyLevel;
  /** Off while there is no AI: 生成记忆卡 and 问 AI do not show. */
  ai?: boolean;
  onAction: (a: SelectionAction, text: string) => void;
}) {
  const t = useT();
  const blocked = aiBlockedReason(t, privacy);
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (disabled) return;
    const sync = () => {
      const sel = getSelection();
      const el = root.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !el) return setAt(null);
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setAt(null);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) return setAt(null);
      setDismissed(false);
      setAt({ x: r.left + r.width / 2, y: r.top, text: sel.toString() });
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDismissed(true);
    document.addEventListener("selectionchange", sync);
    window.addEventListener("keydown", onKey);
    // The bar is fixed to the window; a scroll moves the text from under it.
    window.addEventListener("scroll", sync, true);
    return () => {
      document.removeEventListener("selectionchange", sync);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", sync, true);
    };
  }, [root, disabled]);

  if (!at || dismissed || disabled) return null;
  const button = (id: SelectionAction, icon: IconName, label: string, extra?: string) => (
    <AriaButton
      className="dem-selbar-btn"
      data-ai={id === "ask-ai" || undefined}
      aria-label={label}
      isDisabled={id === "ask-ai" && !!blocked}
      // Pressing must not move the focus out of the text, or the selection is lost.
      preventFocusOnPress
      onPress={() => onAction(id, at.text)}
    >
      <Icon name={icon} size={14} />
      {extra}
    </AriaButton>
  );
  return (
    <Glass
      refract={false}
      className="dem-selbar"
      role="toolbar"
      aria-label={t("editor.selection")}
      style={{ left: at.x, top: at.y }}
    >
      {ITEMS.map((i) => (
        <Tooltip key={i.id} label={t(i.label)} shortcut={i.shortcut}>
          {button(i.id, i.icon, t(i.label))}
        </Tooltip>
      ))}
      {ai && (
        <>
          <span className="dem-selbar-sep" aria-hidden />
          {button("card", "card", t("editor.toCard"), t("editor.toCard"))}
          <Tooltip label={blocked ?? t("editor.askAi")}>
            {button("ask-ai", "ai", t("editor.askAi"), t("editor.askAi"))}
          </Tooltip>
        </>
      )}
    </Glass>
  );
}
