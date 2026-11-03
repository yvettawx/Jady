// The views in the leftmost bar (docs/05-design.md §2.3). Built-in ones and plugins use one list.
import { useSyncExternalStore, type ComponentType } from "react";
import type { IconName } from "../ui/icons";
import type { WorkspaceApi } from "../workspace/api";

export interface NavView {
  id: string;
  icon: IconName;
  /** A message key. */
  label: string;
  shortcut?: string;
  render: ComponentType<{ workspace: WorkspaceApi }>;
}

const views = new Map<string, NavView>();
let snapshot: NavView[] = [];
const listeners = new Set<() => void>();
const changed = () => {
  snapshot = [...views.values()];
  listeners.forEach((f) => f());
};

export function registerNavView(view: NavView): () => void {
  views.set(view.id, view);
  changed();
  return () => {
    if (views.get(view.id) !== view) return;
    views.delete(view.id);
    changed();
  };
}

export const navViews = () => snapshot;

export const useNavViews = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => snapshot,
  );
