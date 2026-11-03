// The workspace as the rest of the app sees it. Everything that knows about dockview stays in
// this folder; callers open, pin and close tabs and save layouts in our own terms.
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview-react";
import type { TabKind } from "../ui/ContentTab";
import { fromDockview, toDockview, type TabParams } from "./convert";
import { MAX_COLUMNS, MAX_ROWS, readLayout, type Layout } from "./layout";
import { dockviewComponents } from "./parts";
import { panelDefinition } from "./registry";

export interface OpenRequest {
  contentId: string;
  title: string;
  /** A registered panel component. */
  component: string;
  params?: Record<string, unknown>;
}

export interface OpenOptions {
  /** 单击 opens a preview, 双击 a temporary tab (docs/05-design.md §3.1). */
  kind?: TabKind;
  /** ⌘-click: always a new tab, even if the content is open. */
  newTab?: boolean;
  /**
   * 分屏: beside the active cell, in the asked direction or else the other one; a tab when the
   * 3 × 3 limit leaves no room either way.
   */
  split?: "right" | "below";
}

export interface TabInfo {
  id: string;
  contentId: string;
  title: string;
  /** The registered panel it shows. */
  component: string;
  kind: TabKind;
  openedAt: number;
  groupId: string;
  /** The tab that has focus in the whole workspace. */
  isActive: boolean;
  /** Extra data given when it was opened, e.g. its privacy level. */
  params: Record<string, unknown>;
}

export interface Shape {
  columns: number;
  /** Cells per column, left to right. */
  rows: number[];
}

export interface WorkspaceApi {
  open(req: OpenRequest, opts?: OpenOptions): string;
  /** Preview → temporary, e.g. when editing starts. */
  promote(tabId: string): void;
  setPinned(tabId: string, pinned: boolean): void;
  close(tabId: string): void;
  activate(tabId: string): void;
  /** A tab whose panel shows something else now, e.g. the sidebar switching views. */
  retitle(tabId: string, title: string): void;
  /** Merges into a tab's extra data (its privacy level changed, say). */
  setTabParams(tabId: string, patch: Record<string, unknown>): void;
  float(tabId: string): void;
  tabs(): TabInfo[];
  shape(): Shape;
  /** The column index (0-based) of a grid group, or -1 for floating groups. */
  columnOf(groupId: string): number;
  /** Hides or shows every cell of a column (narrow windows, ⌘\\). */
  setColumnVisible(col: number, visible: boolean): void;
  isColumnVisible(col: number): boolean;
  /**
   * Once every column is back and the window is wide again, returns columns and cells to the
   * proportions they had before the first one folded (unfolding in a narrow window cannot).
   */
  fitColumns(): void;
  save(): Layout;
  /** Returns false (and leaves the layout alone) if the saved layout is unusable. */
  load(raw: unknown): boolean;
  subscribe(listener: () => void): () => void;
}

type Params = TabParams & { openedAt?: number };

const paramsOf = (p: IDockviewPanel): Params => (p.params ?? {}) as Params;

export function createWorkspaceApi(dv: DockviewApi): WorkspaceApi {
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((f) => f());
  dv.onDidLayoutChange(emit);
  dv.onDidActivePanelChange(emit);
  let counter = 0;

  const gridGroups = () => dv.groups.filter((g) => g.api.location.type === "grid");

  const shape = (): Shape => {
    const s = dv.toJSON().grid;
    const root = s.root;
    if (root.type === "leaf") return { columns: 1, rows: [1] };
    const cols = s.orientation === "HORIZONTAL" ? (root.data as (typeof root)[]) : [root];
    return {
      columns: cols.length,
      rows: cols.map((c) => (c.type === "leaf" ? 1 : (c.data as unknown[]).length)),
    };
  };

  const columnOf = (groupId: string): number => {
    const s = dv.toJSON().grid;
    const root = s.root;
    if (root.type === "leaf") return (root.data as { id: string }).id === groupId ? 0 : -1;
    const cols = s.orientation === "HORIZONTAL" ? (root.data as (typeof root)[]) : [root];
    return cols.findIndex((c) => JSON.stringify(c).includes(`"id":"${groupId}"`));
  };

  // Where opened content goes: the cell that last showed content. Clicking in 目录 makes the
  // directory's cell active, but a note should still open in the main area (P0.5-06 hand test).
  const isContent = (p: IDockviewPanel | undefined) =>
    !!p && panelDefinition(String(p.api.component))?.role !== "widget";
  let lastContentGroup: string | undefined;
  dv.onDidActivePanelChange(() => {
    const p = dv.activePanel;
    if (p && isContent(p) && p.group.api.location.type === "grid") lastContentGroup = p.group.id;
  });
  const area = (g: DockviewGroupPanel) => g.api.width * g.api.height;
  const targetGroup = (): DockviewGroupPanel | undefined => {
    const grid = gridGroups();
    const active = dv.activeGroup;
    if (active && active.api.location.type === "grid" && isContent(active.activePanel))
      return active;
    const last = grid.find((g) => g.id === lastContentGroup);
    if (last) return last;
    const withContent = grid.filter((g) => g.panels.some(isContent));
    return [...(withContent.length ? withContent : grid)].sort((a, b) => area(b) - area(a))[0];
  };

  const setKind = (p: IDockviewPanel, kind: TabKind) => {
    p.api.updateParameters({ ...paramsOf(p), kind });
    emit();
  };

  // Unfolding a column gives hidden views whatever size they had cached, which after the window
  // was resized squeezes the middle column. Keep the proportions from before the first column
  // folded and put the visible columns and their cells back to them.
  let beforeFold: Layout | null = null;
  const columnGroups = (col: number): DockviewGroupPanel[] => {
    const root = dv.toJSON().grid.root;
    const cols = root.type === "branch" ? (root.data as (typeof root)[]) : [root];
    const ids: string[] = [];
    const walk = (node: typeof root | undefined) => {
      if (!node) return;
      if (node.type === "leaf") ids.push((node.data as { id: string }).id);
      else (node.data as (typeof root)[]).forEach(walk);
    };
    walk(cols[col]);
    return ids.flatMap((id) => dv.groups.find((g) => g.id === id) ?? []);
  };
  const restoreSizes = (l: Layout) => {
    const n = shape().columns;
    if (l.columns.length !== n) return;
    const shown = l.columns.map((_, c) => api.isColumnVisible(c));
    const total = l.columns.reduce((s, c, i) => s + (shown[i] ? c.size : 0), 0);
    l.columns.forEach((c, i) => {
      const gs = columnGroups(i);
      if (!shown[i] || !total || gs.length !== c.cells.length) return;
      gs[0]?.api.setSize({ width: Math.round((c.size / total) * dv.width) });
      gs.forEach((g, j) =>
        g.api.setSize({ height: Math.round((c.cells[j]?.size ?? 0) * dv.height) }),
      );
    });
  };

  const api: WorkspaceApi = {
    open(req, opts = {}) {
      const kind = opts.kind ?? "temp";
      const group = targetGroup();
      if (group && !opts.newTab && !opts.split) {
        const same = group.panels.find((p) => paramsOf(p).contentId === req.contentId);
        // Clicking content that is already the preview here just shows it (or keeps it).
        if (same && paramsOf(same).kind === "preview") {
          if (kind !== "preview") setKind(same, kind);
          same.api.setActive();
          return same.id;
        }
      }
      const id = `${req.contentId}~${++counter}~${Date.now().toString(36)}`;
      const params: Params = {
        contentId: req.contentId,
        kind,
        extra: req.params,
        openedAt: Date.now(),
      };
      const base = { id, component: req.component, tabComponent: "tab", title: req.title, params };
      // A panel registered after the workspace came up (an external plugin's) joins here.
      dockviewComponents();

      if (opts.split && group) {
        const s = shape();
        const col = columnOf(group.id);
        const roomRight = s.columns < MAX_COLUMNS,
          roomBelow = (s.rows[col] ?? MAX_ROWS) < MAX_ROWS;
        // 分屏 asks for "beside"; when one way is full, the other way is still beside.
        const canRight = roomRight && (opts.split === "right" || !roomBelow);
        const canBelow = roomBelow && (opts.split === "below" || !roomRight);
        // A new column always goes at the right of the grid: "right of this cell" would nest
        // a column inside a multi-cell column.
        if (canRight) {
          dv.addPanel({ ...base, position: { direction: "right" } });
          return id;
        }
        if (canBelow) {
          dv.addPanel({ ...base, position: { referenceGroup: group, direction: "below" } });
          return id;
        }
      }
      if (!group) {
        dv.addPanel(base);
        return id;
      }
      // A new preview replaces the group's current preview, in the same place.
      const old =
        kind === "preview" ? group.panels.find((p) => paramsOf(p).kind === "preview") : undefined;
      const index = old ? group.panels.indexOf(old) : undefined;
      dv.addPanel({ ...base, position: { referenceGroup: group, direction: "within", index } });
      old?.api.close();
      return id;
    },
    promote(tabId) {
      const p = dv.getPanel(tabId);
      if (p && paramsOf(p).kind === "preview") setKind(p, "temp");
    },
    setPinned(tabId, pinned) {
      const p = dv.getPanel(tabId);
      if (p) setKind(p, pinned ? "pin" : "temp");
    },
    close(tabId) {
      dv.getPanel(tabId)?.api.close();
    },
    activate(tabId) {
      dv.getPanel(tabId)?.api.setActive();
    },
    setTabParams(tabId, patch) {
      const p = dv.getPanel(tabId);
      if (!p) return;
      const params = paramsOf(p);
      p.api.updateParameters({ ...params, extra: { ...params.extra, ...patch } });
      emit();
    },
    retitle(tabId, title) {
      dv.getPanel(tabId)?.api.setTitle(title);
      emit();
    },
    float(tabId) {
      const p = dv.getPanel(tabId);
      if (p) dv.addFloatingGroup(p, { position: { left: 120, top: 120 }, width: 360, height: 280 });
    },
    tabs() {
      return dv.panels.map((p) => {
        const params = paramsOf(p);
        return {
          id: p.id,
          contentId: params.contentId ?? p.id,
          title: p.title ?? "",
          component: String(p.api.component),
          kind: params.kind ?? "temp",
          openedAt: params.openedAt ?? 0,
          groupId: p.group.id,
          // The one tab with focus in the whole window, not each cell's front tab.
          isActive: dv.activePanel?.id === p.id,
          params: params.extra ?? {},
        };
      });
    },
    shape,
    columnOf,
    setColumnVisible(col, visible) {
      const n = shape().columns;
      const all = () => Array.from({ length: n }, (_, c) => api.isColumnVisible(c)).every(Boolean);
      const change = gridGroups().filter(
        (g) => columnOf(g.id) === col && g.api.isVisible !== visible,
      );
      // Nothing to do (or a column with no cells yet, mid-load): no event, so listeners that
      // fold columns on every change cannot loop.
      if (!change.length) return;
      if (!visible && all()) beforeFold = fromDockview(dv.toJSON());
      for (const g of change) g.api.setVisible(visible);
      if (visible && beforeFold) restoreSizes(beforeFold);
      emit();
    },
    fitColumns() {
      const n = shape().columns;
      if (
        !beforeFold ||
        !Array.from({ length: n }, (_, c) => api.isColumnVisible(c)).every(Boolean)
      )
        return;
      restoreSizes(beforeFold);
      beforeFold = null;
      emit();
    },
    isColumnVisible(col) {
      return gridGroups().some((g) => columnOf(g.id) === col && g.api.isVisible);
    },
    save: () => fromDockview(dv.toJSON()),
    load(raw) {
      const l = readLayout(raw);
      if (!l) return false;
      dv.fromJSON(toDockview(l, dv.width, dv.height));
      // A loaded layout has no active tab; make it the front tab of the main content cell, so
      // what the window shows (title, status bar) follows the content from the start.
      lastContentGroup = undefined;
      targetGroup()?.activePanel?.api.setActive();
      emit();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}
