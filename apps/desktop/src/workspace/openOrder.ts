// The order of the 打开的内容 list (docs/05-design.md §3.2): pinned tabs first, then
// temporary ones, newest first. Once the user drags an entry the list keeps their order;
// a newly opened temporary tab goes to the top of the temporary section. Entries never
// cross between the two sections by dragging.

export interface OpenEntry {
  id: string;
  pinned: boolean;
  openedAt: number;
}

/** The ids in display order. `manual` is the order the user dragged into, if any. */
export function orderOpen(entries: OpenEntry[], manual: string[] | null): string[] {
  const section = (pinned: boolean) => {
    const xs = entries.filter((e) => e.pinned === pinned);
    const byTime = [...xs].sort((a, b) => b.openedAt - a.openedAt).map((e) => e.id);
    if (!manual) return byTime;
    const known = manual.filter((id) => xs.some((e) => e.id === id));
    const fresh = byTime.filter((id) => !known.includes(id));
    return [...fresh, ...known];
  };
  return [...section(true), ...section(false)];
}

/**
 * Moves `dragged` before or after `target`. Returns the new manual order, or null when the
 * move would cross between pinned and temporary.
 */
export function moveOpen(
  entries: OpenEntry[],
  manual: string[] | null,
  dragged: string,
  target: string,
  where: "before" | "after",
): string[] | null {
  const d = entries.find((e) => e.id === dragged),
    t = entries.find((e) => e.id === target);
  if (!d || !t || d.pinned !== t.pinned || dragged === target) return null;
  const order = orderOpen(entries, manual).filter((id) => id !== dragged);
  const i = order.indexOf(target) + (where === "after" ? 1 : 0);
  order.splice(i, 0, dragged);
  return order;
}
