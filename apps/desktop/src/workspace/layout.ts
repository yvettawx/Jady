// Our own save format for a workspace layout, independent of the docking library
// (docs/05-design.md §2.2: at most 3 columns, at most 3 cells per column).
// It is local interface state, not part of the library format, but it carries a version
// so a later change can migrate saved layouts (decided 2026-10-21).
import type { TabKind } from "../ui/ContentTab";

export const LAYOUT_VERSION = 1;
export const MAX_COLUMNS = 3;
export const MAX_ROWS = 3;

export interface SavedTab {
  /** One tab; the same content may be open in several tabs. */
  id: string;
  contentId: string;
  /** Registered panel component that draws it. */
  component: string;
  title: string;
  kind: TabKind;
  params?: Record<string, unknown>;
}

export interface SavedCell {
  /** Share of the column's height, 0–1. */
  size: number;
  tabs: string[];
  active?: string;
}

export interface SavedColumn {
  /** Share of the workspace width, 0–1. */
  size: number;
  cells: SavedCell[];
}

export interface SavedFloating {
  tabs: string[];
  active?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutV1 {
  version: 1;
  columns: SavedColumn[];
  floating: SavedFloating[];
  tabs: Record<string, SavedTab>;
}

export type Layout = LayoutV1;

/** Checks the shape rules; returns what is wrong, or null. */
export function layoutProblem(l: Layout): string | null {
  if (l.version !== LAYOUT_VERSION) return `unknown layout version ${String(l.version)}`;
  if (l.columns.length === 0) return "no columns";
  if (l.columns.length > MAX_COLUMNS) return `${l.columns.length} columns`;
  for (const c of l.columns) {
    if (c.cells.length === 0) return "empty column";
    if (c.cells.length > MAX_ROWS) return `${c.cells.length} cells in a column`;
  }
  const placed = [...l.columns.flatMap((c) => c.cells), ...l.floating].flatMap((x) => x.tabs);
  for (const id of placed) if (!l.tabs[id]) return `tab ${id} has no entry`;
  return null;
}

/**
 * Reads a saved layout, migrating older versions. Returns null for anything unusable, so the
 * caller falls back to the default layout rather than failing to start.
 */
export function readLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Layout;
  return layoutProblem(l) === null ? l : null;
}
