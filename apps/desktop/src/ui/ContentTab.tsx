// What one open piece of content looks like as a tab (docs/05-design.md §3.2). The workspace
// (dockview) owns dragging and ordering; this only draws the tab and its close button.
import { Button as AriaButton } from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./content-tab.css";

/** 固定 (never closes by itself), 临时 (default), 预览 (italic, replaced by the next preview). */
export type TabKind = "pin" | "temp" | "preview";

export function ContentTab({
  title,
  kind = "temp",
  icon,
  isActive = false,
  session,
  locked,
  onClose,
}: {
  title: string;
  kind?: TabKind;
  /** The content type's icon. */
  icon?: IconName;
  isActive?: boolean;
  /** Authorised chats carry a mark; the two kinds differ. */
  session?: "auth" | "webAuth";
  /** The content's privacy level, when it has one worth a lock (05 §5.6, A.5). */
  locked?: "sensitive" | "private" | "secret";
  onClose?: () => void;
}) {
  const t = useT();
  return (
    <span
      className="dem-ctab"
      data-kind={kind}
      data-active={isActive || undefined}
      // Middle click closes, as in browsers.
      onAuxClick={(e) => e.button === 1 && kind !== "pin" && onClose?.()}
    >
      {kind === "pin" && (
        <span className="dem-ctab-pin" role="img" aria-label={t("tab.pinned")}>
          ◆
        </span>
      )}
      {icon && <Icon name={icon} size={14} className="dem-ctab-icon" />}
      {locked && (
        <span
          className="dem-ctab-lock"
          data-privacy={locked}
          role="img"
          aria-label={t(`privacy.${locked}`)}
        >
          <Icon name="lock" size={12} />
        </span>
      )}
      {session && (
        <span
          className="dem-ctab-session"
          data-session={session}
          role="img"
          aria-label={t(`tab.${session}`)}
        >
          <Icon name={session === "auth" ? "privacy" : "web"} size={12} />
        </span>
      )}
      <span className="dem-ctab-title">{title}</span>
      {kind !== "pin" && onClose && (
        <AriaButton
          className="dem-ctab-close"
          aria-label={t("tab.close", { title })}
          onPress={onClose}
          // Keep a press on × from starting a tab drag in the workspace.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="close" size={12} />
        </AriaButton>
      )}
    </span>
  );
}
