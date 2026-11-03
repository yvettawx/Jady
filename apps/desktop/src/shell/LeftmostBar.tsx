// 最左栏 (docs/05-design.md §2.3): sidebar views, notifications, spaces, settings. Always there.
import type { ReactNode } from "react";
import {
  Dialog,
  DialogTrigger,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
  type Key,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { Tooltip } from "../ui/Tooltip";
import { fillPair, type SchemeId } from "../theme/tokens.ts";
import { shortcutOf, useCommandsVersion } from "./commands";
import { spaceColors, type Space } from "./spaces";
import "./leftmost.css";

export interface SidebarView {
  id: string;
  icon: IconName;
  label: string;
  shortcut?: string;
}

export function LeftmostBar({
  views,
  view,
  onView,
  notifications,
  notificationsOpen,
  onNotificationsOpen,
  spaces,
  scheme,
  space,
  onSpace,
  onHome,
  floating,
  onNewSpace,
  onSettings,
}: {
  views: SidebarView[];
  view: string;
  onView: (id: string) => void;
  notifications: ReactNode[];
  /** Controlled so ⌘⇧N can open the list. */
  notificationsOpen: boolean;
  onNotificationsOpen: (open: boolean) => void;
  spaces: Space[];
  scheme: SchemeId;
  space: string;
  onSpace: (id: string) => void;
  /** Pressing the current space again goes to its home page. */
  onHome: () => void;
  /** On the home page: the view floating out (null for none). Undefined elsewhere. */
  floating?: string | null;
  onNewSpace: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  // Shortcuts come from the command registry, so a change in Settings shows here at once.
  useCommandsVersion();
  return (
    <Glass className="dem-leftmost" refract>
      <ToggleButtonGroup
        aria-label={t("shell.views")}
        className="dem-leftmost-group"
        orientation="vertical"
        selectionMode="single"
        // On the home page the views float out and can be closed again; elsewhere one is
        // always showing in the sidebar.
        disallowEmptySelection={floating === undefined}
        selectedKeys={floating === undefined ? [view] : floating ? [floating] : []}
        onSelectionChange={(keys: Set<Key>) => {
          const [k] = keys;
          if (k !== undefined) onView(String(k));
          else if (floating) onView(floating);
        }}
      >
        {views.map((v) => (
          <Tooltip
            key={v.id}
            label={v.label}
            shortcut={shortcutOf(`shell.view.${v.id}`)}
            placement="right"
          >
            <ToggleButton id={v.id} className="dem-leftmost-btn" aria-label={v.label}>
              <Icon name={v.icon} size={18} />
            </ToggleButton>
          </Tooltip>
        ))}
      </ToggleButtonGroup>

      <span className="dem-leftmost-notify">
        <DialogTrigger isOpen={notificationsOpen} onOpenChange={onNotificationsOpen}>
          <Tooltip
            label={t("shell.notifications")}
            shortcut={shortcutOf("shell.notifications")}
            placement="right"
          >
            <Button variant="quiet" icon="notifications" aria-label={t("shell.notifications")} />
          </Tooltip>
          <Popover className="dem-popover dem-notify" placement="right top" offset={10}>
            <Dialog className="dem-notify-dialog" aria-label={t("shell.notifications")}>
              {notifications.length ? (
                <ul className="dem-notify-list">
                  {notifications.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : (
                <p className="dem-notify-empty">{t("shell.notifications.empty")}</p>
              )}
            </Dialog>
          </Popover>
        </DialogTrigger>
        {notifications.length > 0 && <span className="dem-leftmost-dot" aria-hidden />}
      </span>

      <span className="dem-leftmost-spacer" />

      <ToggleButtonGroup
        aria-label={t("shell.spaces")}
        className="dem-leftmost-group"
        orientation="vertical"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[space]}
        onSelectionChange={(keys: Set<Key>) => {
          const [k] = keys;
          if (k !== undefined) onSpace(String(k));
        }}
      >
        {spaces.map((s, i) => {
          const [a, b] = spaceColors(s, scheme);
          const { fill, on } = fillPair(a);
          return (
            <Tooltip
              key={s.id}
              label={s.name}
              shortcut={shortcutOf(`shell.space.${i + 1}`)}
              placement="right"
            >
              <ToggleButton
                id={s.id}
                className="dem-space-btn"
                aria-label={s.name}
                onPress={() => s.id === space && onHome()}
                style={{ background: `linear-gradient(135deg, ${fill}, ${b})`, color: on }}
              >
                {[...s.name][0]}
              </ToggleButton>
            </Tooltip>
          );
        })}
      </ToggleButtonGroup>
      <Tooltip label={t("shell.newSpace")} placement="right">
        <Button variant="quiet" icon="plus" aria-label={t("shell.newSpace")} onPress={onNewSpace} />
      </Tooltip>
      <Tooltip
        label={t("shell.settings")}
        shortcut={shortcutOf("shell.settings")}
        placement="right"
      >
        <Button
          variant="quiet"
          icon="settings"
          aria-label={t("shell.settings")}
          onPress={onSettings}
        />
      </Tooltip>
    </Glass>
  );
}
