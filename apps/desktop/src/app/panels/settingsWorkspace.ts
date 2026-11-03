// The settings page's way to open something in the workspace.
import { useSyncExternalStore } from "react";
import type { WorkspaceApi } from "../../workspace/api";

let current: WorkspaceApi | null = null;
const listeners = new Set<() => void>();

export function setSettingsWorkspace(ws: WorkspaceApi | null) {
  current = ws;
  listeners.forEach((f) => f());
}

export const useSettingsWorkspace = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => current,
  );
