// What the home page shows. Built-in widgets and plugins register the same way; where each one goes
// is data, so dragging and adding them (PRD H4, P2) can come without changing this.
import { useSyncExternalStore } from "react";
import type { HomeWidget } from "./HomeGrid";

const widgets = new Map<string, HomeWidget>();
let snapshot: HomeWidget[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  snapshot = [...widgets.values()];
  listeners.forEach((f) => f());
};

export function registerHomeWidget(widget: HomeWidget): () => void {
  widgets.set(widget.id, widget);
  changed();
  return () => {
    if (widgets.get(widget.id) !== widget) return;
    widgets.delete(widget.id);
    changed();
  };
}

export const homeWidgets = () => snapshot;

export const useHomeWidgets = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => snapshot,
  );
