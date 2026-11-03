// 窗口变窄时 (docs/05-design.md §2.6): the right column folds first, then the left; the
// leftmost bar always stays. ⌘\ and ⌘⌥\ fold or unfold a column by hand; that choice holds
// until the window crosses a threshold again, which hands control back to the width rule.
import { useEffect, useState } from "react";
import type { WorkspaceApi } from "../workspace/api";

export type Side = "left" | "right";

/** Workspace widths (px) below which a side column folds on its own. */
export const FOLD_RIGHT_BELOW = 960;
export const FOLD_LEFT_BELOW = 640;

/**
 * Which column each side is. Only a three-column layout has both sides around a main column;
 * with two, the left one folds and the right one is the main column; one column never folds.
 */
export function sideColumns(columns: number): Partial<Record<Side, number>> {
  if (columns >= 3) return { left: 0, right: columns - 1 };
  if (columns === 2) return { left: 0 };
  return {};
}

const band = (w: number) => (w < FOLD_LEFT_BELOW ? 0 : w < FOLD_RIGHT_BELOW ? 1 : 2);

export function useColumnFolding(ws: WorkspaceApi | null, width: number) {
  const [manual, setManual] = useState<Partial<Record<Side, boolean>>>({});
  const [lastBand, setLastBand] = useState(() => band(width));
  // Adjusting state while rendering (not in an effect) so the new rule applies in the same frame.
  if (band(width) !== lastBand) {
    setLastBand(band(width));
    setManual({});
  }
  const folded: Record<Side, boolean> = {
    left: manual.left ?? width < FOLD_LEFT_BELOW,
    right: manual.right ?? width < FOLD_RIGHT_BELOW,
  };
  const [columns, setColumns] = useState(0);

  // Re-applied on every layout change: loading a space's layout or dragging a tab can bring a
  // folded column back, or move the right column.
  useEffect(() => {
    if (!ws) return;
    let busy = false;
    const apply = () => {
      // Our own setColumnVisible emits a change too; that one needs no second pass.
      if (busy) return;
      busy = true;
      try {
        sync();
      } finally {
        busy = false;
      }
    };
    const sync = () => {
      const n = ws.shape().columns;
      setColumns(n);
      const sides = sideColumns(n);
      for (let c = 0; c < n; c++) {
        const hide = (c === sides.left && folded.left) || (c === sides.right && folded.right);
        if (ws.isColumnVisible(c) === hide) ws.setColumnVisible(c, !hide);
      }
    };
    apply();
    return ws.subscribe(apply);
  }, [ws, folded.left, folded.right]);

  // Back to a wide window with nothing folded: restore the proportions from before folding,
  // after the workspace has laid itself out at the new width.
  const wide = band(width) === 2 && !folded.left && !folded.right;
  useEffect(() => {
    if (!ws || !wide) return;
    const f = requestAnimationFrame(() => ws.fitColumns());
    return () => cancelAnimationFrame(f);
  }, [ws, wide]);

  const sides = sideColumns(columns);
  return {
    /** Sides that are folded right now and have a column to unfold. */
    folded: {
      left: folded.left && sides.left !== undefined,
      right: folded.right && sides.right !== undefined,
    },
    toggle(side: Side) {
      if (sides[side] === undefined) return;
      setManual((m) => ({ ...m, [side]: !folded[side] }));
    },
  };
}
