// One setting: its name on the left (with an optional line under it), the control on the right.
// Hidden while the settings search does not match its name or keywords (pinyin initials too).
import { useContext, type ReactNode } from "react";
import { rowMatches, SettingsQueryContext } from "./context";

export function SettingRow({
  label,
  hint,
  keywords,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  keywords?: string[];
  /** The control takes a row of its own under the name (swatches, previews). */
  wide?: boolean;
  children: ReactNode;
}) {
  const query = useContext(SettingsQueryContext);
  if (!rowMatches(query, label, keywords)) return null;
  return (
    <div className="dem-setting" data-wide={wide || undefined}>
      <div className="dem-setting-name">
        <span className="dem-setting-label">{label}</span>
        {hint && <span className="dem-setting-hint">{hint}</span>}
      </div>
      <div className="dem-setting-control">{children}</div>
    </div>
  );
}
