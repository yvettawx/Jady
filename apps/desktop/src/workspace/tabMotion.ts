// Workspace motion. Tabs: when a drop moves tabs, each tab slides from where it was to where
// it is now, and the dropped tab fades in. dockview's own "smooth" tab animation breaks stacking
// a tab onto another group's tab (dockview 8.6.1, pointer dragging), so we animate on drop.
import type { DockviewApi } from "dockview-react";

type Spot = { x: number; y: number; group: Element | null };

function snapshot(root: HTMLElement): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  for (const el of root.querySelectorAll<HTMLElement>(".dem-ws-tab[data-tab-id]")) {
    const tab = el.closest(".dv-tab");
    if (!tab) continue;
    const r = tab.getBoundingClientRect();
    spots.set(el.dataset.tabId ?? "", { x: r.left, y: r.top, group: tab.closest(".dv-groupview") });
  }
  return spots;
}

/** Wires the motion to a dockview instance inside `root`; returns a disposer. */
export function animateTabMoves(dv: DockviewApi, root: HTMLElement): () => void {
  let before: Map<string, Spot> | null = null;
  let dropped: string | null = null;
  const start = dv.onWillDragPanel((e) => {
    before = snapshot(root);
    dropped = e.panel.id;
  });
  const done = dv.onDidMovePanel(() => {
    const prev = before;
    const moved = dropped;
    before = null;
    dropped = null;
    if (!prev) return;
    // Wait for dockview to lay the tabs out in their new places.
    requestAnimationFrame(() => {
      const css = getComputedStyle(document.documentElement);
      const duration = parseFloat(css.getPropertyValue("--dem-dur-base")) || 0;
      if (!duration) return; // reduced motion
      const easing = css.getPropertyValue("--dem-ease-spring").trim() || "ease-out";
      for (const [id, now] of snapshot(root)) {
        const tab = root
          .querySelector(`.dem-ws-tab[data-tab-id="${CSS.escape(id)}"]`)
          ?.closest(".dv-tab");
        if (!tab) continue;
        const was = prev.get(id);
        if (id === moved) {
          tab.animate(
            [
              { opacity: 0, transform: "scale(0.92)" },
              { opacity: 1, transform: "none" },
            ],
            { duration, easing },
          );
        } else if (was && was.group === now.group && (was.x !== now.x || was.y !== now.y)) {
          const dx = was.x - now.x,
            dy = was.y - now.y;
          tab.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            duration,
            easing,
          });
        }
      }
    });
  });
  return () => {
    start.dispose();
    done.dispose();
  };
}

type Box = { x: number; y: number; w: number; h: number };

function groupBoxes(dv: DockviewApi): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const g of dv.groups) {
    const r = g.element.getBoundingClientRect();
    if (r.width) out.set(g.id, { x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

/**
 * Layout motion: when a drop or a command splits, stacks or closes cells, the cells that stay
 * glide and resize from where they were, and a new cell fades in. Resizing the window or
 * dragging a divider is not animated: those already follow the hand.
 */
export function animateLayoutChanges(dv: DockviewApi): () => void {
  let last = groupBoxes(dv);
  let structural = false;
  let frame = 0;
  const settle = () => {
    frame = 0;
    const now = groupBoxes(dv);
    const css = getComputedStyle(document.documentElement);
    const duration = parseFloat(css.getPropertyValue("--dem-dur-base")) || 0;
    if (structural && duration) {
      const easing = css.getPropertyValue("--dem-ease-spring").trim() || "ease-out";
      for (const g of dv.groups) {
        const to = now.get(g.id);
        if (!to) continue;
        const from = last.get(g.id);
        if (!from) {
          g.element.animate(
            [
              { opacity: 0, transform: "scale(0.96)" },
              { opacity: 1, transform: "none" },
            ],
            {
              duration,
              easing,
            },
          );
          continue;
        }
        const dx = from.x - to.x,
          dy = from.y - to.y,
          sx = from.w / to.w,
          sy = from.h / to.h;
        if (Math.abs(dx) + Math.abs(dy) < 1 && Math.abs(sx - 1) + Math.abs(sy - 1) < 0.01) continue;
        g.element.animate(
          [
            {
              transformOrigin: "0 0",
              transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
            },
            { transformOrigin: "0 0", transform: "none" },
          ],
          { duration, easing },
        );
      }
    }
    structural = false;
    last = now;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(settle);
  };
  const mark = () => {
    structural = true;
    schedule();
  };
  const subs = [
    dv.onDidAddGroup(mark),
    dv.onDidRemoveGroup(mark),
    dv.onDidMovePanel(mark),
    dv.onDidLayoutChange(schedule),
  ];
  window.addEventListener("resize", schedule);
  return () => {
    cancelAnimationFrame(frame);
    subs.forEach((s) => s.dispose());
    window.removeEventListener("resize", schedule);
  };
}
