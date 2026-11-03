// 收藏 (PRD H1): a short list kept with this device's settings. Only ids, so nothing to leak.
import { useSyncExternalStore } from "react";
import { api } from "./api";

const KEY = "ui-favorites";
let ids: string[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

export async function loadFavorites(): Promise<void> {
  try {
    ids = JSON.parse((await api.localGet(KEY)) ?? "[]") as string[];
  } catch {
    ids = [];
  }
  changed();
}

export function toggleFavorite(id: string): void {
  ids = ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids];
  void api.localSet(KEY, JSON.stringify(ids));
  changed();
}

export const useFavorites = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => ids,
  );
