import type { ReactNode } from "react";
import { ProgressBar } from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./states.css";

/** What an empty list, panel or search shows: what is missing and, at most, one way forward. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="dem-empty">
      {icon && <Icon name={icon} size={28} strokeWidth={1.25} className="dem-empty-icon" />}
      <p className="dem-empty-title">{title}</p>
      {description && <p className="dem-empty-desc">{description}</p>}
      {action}
    </div>
  );
}

/** An indeterminate spinner. The label is read out; show it only when showLabel is set. */
export function Spinner({ label, showLabel = false }: { label?: string; showLabel?: boolean }) {
  const t = useT();
  const text = label ?? t("state.loading");
  return (
    <ProgressBar isIndeterminate aria-label={text} className="dem-spinner">
      <span className="dem-spinner-ring" aria-hidden />
      {showLabel && <span className="dem-spinner-label">{text}</span>}
    </ProgressBar>
  );
}

/** Grey placeholder lines while content loads; the container should set aria-busy. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="dem-skeleton" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="dem-skeleton-line" style={{ width: `${92 - ((i * 23) % 40)}%` }} />
      ))}
    </div>
  );
}
