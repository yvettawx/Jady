import type { ReactNode } from "react";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./badge.css";

export type BadgeTone = "neutral" | "accent" | "ai" | "ok" | "warn" | "danger";

export function Badge({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: BadgeTone;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className="dem-badge" data-tone={tone}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/** Privacy levels (PRD F1). 普通 shows nothing; the others show only the level and a lock. */
export type PrivacyLevel = "normal" | "sensitive" | "private" | "secret";

export function PrivacyMark({ level }: { level: PrivacyLevel }) {
  const t = useT();
  if (level === "normal") return null;
  return (
    <span className="dem-mark" data-privacy={level}>
      <Icon name="lock" size={12} />
      {t(`privacy.${level}`)}
    </span>
  );
}

/** Source and confidence marks (PRD A8). */
export type SourceKind = "mine" | "import" | "aiMemory" | "aiSearch" | "unverified" | "conflict";

const SOURCE_ICON: Record<SourceKind, IconName> = {
  mine: "edit",
  import: "import",
  aiMemory: "ai",
  aiSearch: "web",
  unverified: "help",
  conflict: "warning",
};

export function SourceMark({ kind }: { kind: SourceKind }) {
  const t = useT();
  return (
    <span className="dem-mark" data-source={kind}>
      <Icon name={SOURCE_ICON[kind]} size={12} />
      {t(`source.${kind}`)}
    </span>
  );
}
