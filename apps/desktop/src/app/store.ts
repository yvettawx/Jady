// What most of the interface reads at once: every live item, the types and the structure. Lists,
// the launcher, links and the star map all need it synchronously, so it is held here and refreshed
// whenever an item changes. Writing always goes to the core; this is only a copy.
import { useSyncExternalStore } from "react";
import type { ItemView, TagCount, TreeNode, TypeDef } from "../bindings";
import { api, onItemsChanged } from "./api";

export interface LibraryData {
  /** Inbox and active items. 机密 items have no title here. */
  items: ItemView[];
  /** The same items for 目录, the one place 机密 titles show. */
  directory: ItemView[];
  types: TypeDef[];
  tree: TreeNode[];
  tags: TagCount[];
}

const EMPTY: LibraryData = { items: [], directory: [], types: [], tree: [], tags: [] };
let data = EMPTY;
const listeners = new Set<() => void>();

export const library = () => data;

export async function refreshLibrary(): Promise<void> {
  const [items, agreements, directory, types, tree, tags] = await Promise.all([
    api.itemList({
      typeId: null,
      states: ["inbox", "active"],
      container: null,
      tag: null,
      order: "updated",
      limit: null,
    }),
    api.itemList({
      typeId: "agreement",
      states: ["active"],
      container: null,
      tag: null,
      order: "created",
      limit: null,
    }),
    api.directoryList(),
    api.typeList(),
    api.treeList(),
    api.tagList(),
  ]);
  data = { items: [...items, ...agreements], directory, types, tree, tags };
  listeners.forEach((f) => f());
}

/** Keeps the copy current until the returned function is called; a burst of changes is one read. */
export function followLibrary(onError: (e: unknown) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = onItemsChanged(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void refreshLibrary().catch(onError), 150);
  });
  return () => {
    clearTimeout(timer);
    off();
    data = EMPTY;
  };
}

export const useLibrary = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => data,
  );
