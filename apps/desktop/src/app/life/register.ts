// Everything in this folder goes through the same registries a plugin uses.
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { refreshEditors } from "../../editor/pm/ProseEditor";
import { registerHomeWidget } from "../../home/registry";
import { registerCommand } from "../../shell/commands";
import { registerSettingsSection } from "../../settings/SettingsPanel";
import type { Translate } from "../../i18n/messages";
import type { WorkspaceApi } from "../../workspace/api";
import { registerPanel } from "../../workspace/registry";
import { registerNavView } from "../navViews";
import { AgendaWidget, CalendarPanel } from "./Calendar";
import { GitSection } from "./GitSection";
import { GraphPanel } from "./Graph";
import { SyncSection } from "./SyncSection";
import { HabitsWidget } from "./Habits";
import {
  CALENDAR_PANEL,
  GRAPH_PANEL,
  LIFE_PANELS,
  MAP_PANEL,
  STATS_PANEL,
  TIMELINE_PANEL,
  WHEEL_PANEL,
  WHITEBOARD_PANEL,
} from "./ids";
import { LifeView, TemplatesSection } from "./LifeView";
import { SCHEDULED_PANEL, ScheduledPanel } from "./Scheduled";
import { StatsPanel } from "./Stats";
import { TimelinePanel } from "./Timeline";
import { WheelPanel } from "./Wheel";
import { VAULT_PANEL, VaultNav, VaultPanel } from "./VaultPanel";
import { WhiteboardPanel } from "./Whiteboard";
import { TipsWidget } from "./Welcome";
import { MapPanel } from "./WorldMap";
import "./life.css";

registerPanel({ id: CALENDAR_PANEL, icon: "calendar", render: CalendarPanel });
registerPanel({ id: TIMELINE_PANEL, icon: "calendar", render: TimelinePanel });
registerPanel({ id: GRAPH_PANEL, icon: "link", render: GraphPanel });
registerPanel({ id: MAP_PANEL, icon: "place", render: MapPanel });
registerPanel({ id: WHEEL_PANEL, icon: "mastery", render: WheelPanel });
registerPanel({ id: VAULT_PANEL, icon: "passwords", render: VaultPanel });
registerNavView({
  id: "vault",
  icon: "passwords",
  label: "shell.view.vault",
  shortcut: "Mod+Shift+K",
  render: VaultNav,
});
registerPanel({ id: SCHEDULED_PANEL, icon: "ai", render: ScheduledPanel });
registerPanel({ id: STATS_PANEL, icon: "kanban", render: StatsPanel });
registerPanel({ id: WHITEBOARD_PANEL, icon: "edit", render: WhiteboardPanel });
registerPanel({ id: "home-agenda", icon: "calendar", role: "widget", render: AgendaWidget });
registerPanel({ id: "home-habits", icon: "check", role: "widget", render: HabitsWidget });
registerHomeWidget({
  id: "agenda",
  panel: "home-agenda",
  title: "calendar.today.widget",
  col: 0,
  row: 5,
  w: 3,
  h: 2,
});
registerPanel({ id: "home-tips", icon: "read", role: "widget", render: TipsWidget });
registerHomeWidget({
  id: "tips",
  panel: "home-tips",
  title: "tips.title",
  col: 3,
  row: 5,
  w: 6,
  h: 2,
});
registerNavView({
  id: "life",
  icon: "life",
  label: "shell.view.life",
  shortcut: "Mod+Shift+J",
  render: LifeView,
});
registerSettingsSection({ id: "templates", icon: "kanban", Body: TemplatesSection });
registerSettingsSection({ id: "git", icon: "history", Body: GitSection });
registerSettingsSection({ id: "sync", icon: "sync", Body: SyncSection });

/** The habits widget only exists once the template is in use: a new home page stays quiet. */
export function useLifeWidgets(hasHabits: boolean) {
  // A background sync round changed these: open editors catch up.
  useEffect(() => {
    const off = listen<string[]>("sync-changed", (e) => {
      for (const id of e.payload) void refreshEditors(id);
    });
    return () => void off.then((f) => f());
  }, []);
  useEffect(() => {
    if (!hasHabits) return;
    return registerHomeWidget({
      id: "habits",
      panel: "home-habits",
      title: "habit.title",
      col: 9,
      row: 5,
      w: 3,
      h: 2,
    });
  }, [hasHabits]);
}

/** One command for each of these views, so ⌘K reaches them. */
export function lifeCommands(t: Translate, ws: () => WorkspaceApi | null) {
  return LIFE_PANELS.map((p) =>
    registerCommand({
      id: `life.${p.id}`,
      title: t(p.title),
      icon: p.icon,
      run: () => ws()?.open({ contentId: p.id, component: p.id, title: t(p.title) }),
    }),
  );
}
