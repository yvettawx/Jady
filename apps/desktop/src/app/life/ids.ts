import type { IconName } from "../../ui/icons";

export const CALENDAR_PANEL = "calendar";
export const TIMELINE_PANEL = "timeline";
export const GRAPH_PANEL = "graph";
export const MAP_PANEL = "map";
export const WHEEL_PANEL = "wheel";
export const STATS_PANEL = "stats";
export const WHITEBOARD_PANEL = "whiteboard";

export const LIFE_PANELS: { id: string; icon: IconName; title: string }[] = [
  { id: CALENDAR_PANEL, icon: "calendar", title: "calendar.title" },
  { id: TIMELINE_PANEL, icon: "calendar", title: "timeline.title" },
  { id: GRAPH_PANEL, icon: "link", title: "graph.title" },
  { id: MAP_PANEL, icon: "place", title: "map.title" },
  { id: WHEEL_PANEL, icon: "mastery", title: "wheel.title" },
  { id: "scheduled", icon: "ai", title: "scheduled.title" },
];
