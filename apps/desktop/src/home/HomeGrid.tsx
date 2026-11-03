/* eslint-disable react-refresh/only-export-components -- the grid rule lives with the grid */
// The widgets on the home page (docs/05-design.md §8). They are registered panels, the same as
// in the workspace, placed on a 12-column grid. In edit mode (PRD H4) a widget moves by its title,
// resizes by its corner and can be taken off the page.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { Icon } from "../ui/Icon";
import type { WorkspaceApi } from "../workspace/api";
import { panelDefinition } from "../workspace/registry";
import "./home.css";

export const HOME_COLUMNS = 12;

export interface HomeWidget {
  id: string;
  /** A registered panel. */
  panel: string;
  title?: string;
  /** Grid cell of the top-left corner, 0-based, and the size in cells. */
  col: number;
  row: number;
  w: number;
  h: number;
}

export type WidgetPlace = Pick<HomeWidget, "col" | "row" | "w" | "h">;

/** What a drag of (dx, dy) cells does to a place, kept on the grid. */
export function movedBy(
  at: WidgetPlace,
  how: "move" | "resize",
  dx: number,
  dy: number,
): WidgetPlace {
  if (how === "resize") {
    const w = Math.max(2, Math.min(HOME_COLUMNS - at.col, at.w + dx));
    return { ...at, w, h: Math.max(1, at.h + dy) };
  }
  return {
    ...at,
    col: Math.max(0, Math.min(HOME_COLUMNS - at.w, at.col + dx)),
    row: Math.max(0, at.row + dy),
  };
}

export function HomeGrid({
  widgets,
  workspace,
  editing = false,
  onPlace,
  onRemove,
}: {
  widgets: HomeWidget[];
  workspace: WorkspaceApi;
  editing?: boolean;
  onPlace?: (id: string, at: WidgetPlace) => void;
  onRemove?: (id: string) => void;
}) {
  const t = useT();
  const [drag, setDrag] = useState<{ id: string; at: WidgetPlace } | null>(null);
  const start = useRef({ x: 0, y: 0 });

  const begin = (e: ReactPointerEvent, w: HomeWidget, how: "move" | "resize") => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    const grid = (e.currentTarget as HTMLElement).closest<HTMLElement>(".dem-home");
    if (!grid) return;
    const style = getComputedStyle(grid);
    const gap = parseFloat(style.columnGap) || 0;
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const cellW = (grid.clientWidth - pad - gap * (HOME_COLUMNS - 1)) / HOME_COLUMNS + gap;
    const cellH = parseFloat(style.gridAutoRows) + gap;
    start.current = { x: e.clientX, y: e.clientY };
    const origin: WidgetPlace = { col: w.col, row: w.row, w: w.w, h: w.h };
    let latest = origin;
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - start.current.x) / cellW);
      const dy = Math.round((ev.clientY - start.current.y) / cellH);
      latest = movedBy(origin, how, dx, dy);
      setDrag({ id: w.id, at: latest });
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      setDrag(null);
      onPlace?.(w.id, latest);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
  };

  return (
    <>
      {widgets.map((w) => {
        const def = panelDefinition(w.panel);
        if (!def) return null;
        const Panel = def.render;
        const body = (
          <Panel
            tabId={`home:${w.id}`}
            contentId={w.id}
            kind="pin"
            params={{}}
            workspace={workspace}
          />
        );
        const at = drag?.id === w.id ? drag.at : w;
        const place = {
          gridColumn: `${at.col + 1} / span ${at.w}`,
          gridRow: `${at.row + 1} / span ${at.h}`,
        };
        return (
          <Glass
            key={w.id}
            className="dem-home-widget"
            style={place}
            data-editing={editing || undefined}
            data-widget={w.id}
          >
            {w.title && (
              <h2 className="dem-home-widget-title" onPointerDown={(e) => begin(e, w, "move")}>
                {def.icon && <Icon name={def.icon} size={14} />}
                {w.title}
                {editing && (
                  <span className="dem-home-widget-remove">
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="close"
                      aria-label={t("home.removeWidget")}
                      onPress={() => onRemove?.(w.id)}
                    />
                  </span>
                )}
              </h2>
            )}
            <div className="dem-home-widget-body">{body}</div>
            {editing && (
              <span
                className="dem-home-widget-resize"
                aria-hidden
                onPointerDown={(e) => begin(e, w, "resize")}
              />
            )}
          </Glass>
        );
      })}
    </>
  );
}
