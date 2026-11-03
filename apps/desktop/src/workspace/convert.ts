// Converts between our layout format and dockview's own serialisation, so saved layouts never
// depend on the docking library (docs/spikes/07-ui-components.md, conclusion 3).
import { Orientation, type SerializedDockview, type SerializedGridObject } from "dockview-react";
import type { TabKind } from "../ui/ContentTab";
import {
  LAYOUT_VERSION,
  type Layout,
  type SavedCell,
  type SavedColumn,
  type SavedTab,
} from "./layout";

/** What we keep in each dockview panel's params. */
export interface TabParams {
  contentId: string;
  kind: TabKind;
  extra?: Record<string, unknown>;
}

// dockview does not export its group state type; take it from a type it does export.
type GroupPanelViewState = NonNullable<
  NonNullable<SerializedDockview["floatingGroups"]>[number]["data"]
>;
type Grid = SerializedGridObject<GroupPanelViewState>;

export function toDockview(l: Layout, width: number, height: number): SerializedDockview {
  let g = 0;
  const group = (tabs: string[], active?: string): GroupPanelViewState => ({
    id: `g${++g}`,
    views: tabs,
    activeView: active ?? tabs[0],
  });
  const columns: Grid[] = l.columns.map((c: SavedColumn) => {
    const size = Math.round(c.size * width);
    if (c.cells.length === 1) {
      const only = c.cells[0] as SavedCell;
      return { type: "leaf", data: group(only.tabs, only.active), size };
    }
    return {
      type: "branch",
      size,
      data: c.cells.map((cell) => ({
        type: "leaf",
        data: group(cell.tabs, cell.active),
        size: Math.round(cell.size * height),
      })),
    };
  });
  const panels: SerializedDockview["panels"] = {};
  for (const t of Object.values(l.tabs)) {
    const params: TabParams = { contentId: t.contentId, kind: t.kind, extra: t.params };
    panels[t.id] = {
      id: t.id,
      contentComponent: t.component,
      tabComponent: "tab",
      title: t.title,
      params,
    };
  }
  return {
    grid: {
      root: { type: "branch", data: columns, size: height },
      width,
      height,
      orientation: Orientation.HORIZONTAL,
    },
    panels,
    floatingGroups: l.floating.map((f) => ({
      data: group(f.tabs, f.active),
      position: { left: f.x, top: f.y, width: f.w, height: f.h },
    })),
  };
}

/** Leaves of a subtree in reading order, with their sizes. */
function leaves(node: Grid): { data: GroupPanelViewState; size: number }[] {
  if (node.type === "leaf")
    return [{ data: node.data as GroupPanelViewState, size: node.size ?? 1 }];
  return (node.data as Grid[]).flatMap(leaves);
}

const share = (xs: number[]) => {
  const total = xs.reduce((a, b) => a + b, 0) || 1;
  return xs.map((x) => +(x / total).toFixed(4));
};

export function fromDockview(d: SerializedDockview): Layout {
  const root = d.grid.root;
  // A horizontal root holds columns; anything nested deeper is flattened into cells.
  const colNodes: Grid[] =
    root.type === "leaf"
      ? [root]
      : d.grid.orientation === Orientation.HORIZONTAL
        ? (root.data as Grid[])
        : [root];
  const colShares = share(colNodes.map((c) => c.size ?? 1));
  const columns: SavedColumn[] = colNodes.map((c, i) => {
    const ls = leaves(c);
    const cellShares = share(ls.map((x) => x.size));
    return {
      size: colShares[i] ?? 0,
      cells: ls.map((x, j) => ({
        size: cellShares[j] ?? 0,
        tabs: x.data.views,
        active: x.data.activeView,
      })),
    };
  });
  const floating = (d.floatingGroups ?? []).flatMap((f) => {
    const data = f.data ?? leaves(f.grid?.root as Grid)[0]?.data;
    if (!data) return [];
    const p = f.position as { left?: number; top?: number; width: number; height: number };
    return [
      {
        tabs: data.views,
        active: data.activeView,
        x: p.left ?? 0,
        y: p.top ?? 0,
        w: p.width,
        h: p.height,
      },
    ];
  });
  const tabs: Record<string, SavedTab> = {};
  for (const p of Object.values(d.panels)) {
    const params = (p.params ?? {}) as Partial<TabParams>;
    tabs[p.id] = {
      id: p.id,
      contentId: params.contentId ?? p.id,
      component: p.contentComponent ?? "",
      title: p.title ?? "",
      kind: params.kind ?? "temp",
      ...(params.extra ? { params: params.extra } : {}),
    };
  }
  return { version: LAYOUT_VERSION, columns, floating, tabs };
}
