// The dockable workspace (docs/05-design.md §2.2, §3.2): every cell is a floating glass pane,
// at most 3 columns × 3 cells, tabs pinned / temporary / preview, our own save format.
import { DockviewReact, type DockviewApi, type DockviewGroupPanel } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/context";
import { useGlass } from "../ui/glass/context";
import { createWorkspaceApi, type WorkspaceApi } from "./api";
import { WorkspaceContext } from "./context";
import { MAX_COLUMNS, MAX_ROWS } from "./layout";
import { dockMessages } from "./messages";
import { dockviewComponents, WorkspaceTab } from "./parts";
import { animateLayoutChanges, animateTabMoves } from "./tabMotion";
import "./workspace.css";

export type TabArrangement = "horizontal" | "vertical";

const MIN_CELL = { w: 160, h: 96 };

export function Workspace({
  arrangement = "horizontal",
  dndStrategy = "pointer",
  onReady,
}: {
  /** 横排 shows each cell's tabs; 竖排 shows only a thin title (tabs live in 打开的内容). */
  arrangement?: TabArrangement;
  /** Pointer events drag more smoothly than HTML5 drag-and-drop in WebKit (P0.5-06-7). */
  dndStrategy?: "pointer" | "html5";
  onReady: (api: WorkspaceApi) => void;
}) {
  const t = useT();
  const messages = useMemo(() => dockMessages(t), [t]);
  const [api, setApi] = useState<WorkspaceApi | null>(null);
  const [dragging, setDragging] = useState(false);
  const { register, refracting } = useGlass();
  const groups = useRef(
    new Map<string, { el: HTMLElement; group: DockviewGroupPanel; off: () => void }>(),
  );
  const components = useMemo(() => dockviewComponents(), []);
  const ready = useRef(onReady);

  // Each grid group is a glass pane over the wallpaper; the WebGL layer draws under it.
  // Floating groups sit over other panes' content, which that layer cannot draw, so they
  // use CSS blur (docs/05-design.md appendix B.2).
  const refractingNow = useRef(refracting);
  const paint = (g: DockviewGroupPanel) => {
    const grid = g.api.location.type === "grid";
    g.element.toggleAttribute("data-glass-refract", grid);
    g.element.toggleAttribute("data-refract", grid && refractingNow.current);
  };
  const glassGroup = (g: DockviewGroupPanel) => {
    if (groups.current.has(g.id)) return;
    const el = g.element;
    el.classList.add("dem-glass");
    paint(g);
    const moved = g.api.onDidLocationChange(() => paint(g));
    // Below this a cell is unreadable; the shell collapses columns before that (§2.6, P1).
    g.api.setConstraints({ minimumWidth: MIN_CELL.w, minimumHeight: MIN_CELL.h });
    const off = register(el);
    groups.current.set(g.id, {
      el,
      group: g,
      off: () => {
        off();
        moved.dispose();
      },
    });
  };
  useEffect(() => {
    refractingNow.current = refracting;
    for (const { group } of groups.current.values()) paint(group);
  });
  // Register the groups that already exist on (re)mount: React's StrictMode unmounts and
  // remounts once in development, and dockview does not announce existing groups again.
  const dvRef = useRef<DockviewApi | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const all = groups.current;
    for (const g of dvRef.current?.groups ?? []) glassGroup(g);
    return () => {
      for (const g of all.values()) g.off();
      all.clear();
    };
    // glassGroup only reads refs and the stable register function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const init = (dv: DockviewApi) => {
    dvRef.current = dv;
    const ws = createWorkspaceApi(dv);
    // The 3 × 3 rule only looks at drops that would split a cell or add a column or row.
    // Drops on a tab strip just reorder or stack tabs and are always allowed.
    dv.onWillShowOverlay((ev) => {
      if (ev.kind === "tab" || ev.kind === "header_space") return;
      const pos = ev.position;
      if (pos === "center") return;
      const s = ws.shape();
      if (ev.kind === "edge") {
        // A top or bottom edge would add a row spanning every column, which the grid has no place for.
        if (pos === "top" || pos === "bottom" || s.columns >= MAX_COLUMNS) ev.preventDefault();
        return;
      }
      const group = ev.group;
      if (!group || group.api.location.type !== "grid") return;
      if (pos === "left" || pos === "right") {
        // Splitting a cell sideways would put two columns inside one.
        ev.preventDefault();
        return;
      }
      if ((s.rows[ws.columnOf(group.id)] ?? MAX_ROWS) >= MAX_ROWS) ev.preventDefault();
    });
    for (const g of dv.groups) glassGroup(g);
    dv.onDidAddGroup(glassGroup);
    dv.onDidRemoveGroup((g) => {
      groups.current.get(g.id)?.off();
      groups.current.delete(g.id);
    });
    if (rootRef.current) animateTabMoves(dv, rootRef.current);
    animateLayoutChanges(dv);
    dv.onWillDragPanel(() => setDragging(true));
    dv.onWillDragGroup(() => setDragging(true));
    setApi(ws);
    ready.current(ws);
  };

  // Drag start has an event; drag end is noticed on the window.
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    // Esc cancels a drag: dockview gives up on a cancelled pointer and leaves everything in place.
    let pointerId = 0;
    const track = (e: PointerEvent) => {
      pointerId = e.pointerId;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        window.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
    };
    window.addEventListener("pointermove", track, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerup", end);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", track, { capture: true });
      window.removeEventListener("pointerup", end);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, [dragging]);

  return (
    <WorkspaceContext.Provider value={api}>
      <div
        ref={rootRef}
        className="dem-workspace"
        data-tabs={arrangement}
        data-dragging={dragging || undefined}
      >
        <DockviewReact
          className="dockview-theme-dem"
          // A thin insertion line shows where a dragged tab lands; tabMotion.ts animates the
          // move on drop (dockview's "smooth" option breaks stacking onto another group's tab).
          theme={{ name: "dem", className: "dockview-theme-dem", gap: 8, dndTabIndicator: "line" }}
          components={components}
          tabComponents={{ tab: WorkspaceTab }}
          defaultTabComponent={WorkspaceTab}
          dndStrategy={dndStrategy}
          messages={messages}
          onReady={(e) => init(e.api)}
        />
      </div>
    </WorkspaceContext.Provider>
  );
}
