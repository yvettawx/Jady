// 地图 (B4): whatever has a latitude and a longitude, on an outline of the land that ships with the
// app. Nothing goes over the network: map tiles would tell a server which places are in the library.
import { useMemo, useRef, useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { EmptyState } from "../../ui/States";
import type { PanelProps } from "../../workspace/registry";
import { openItem } from "../actions";
import { api, parseFields } from "../api";
import { useLive } from "../live";
import { titleOf } from "../model";
import { useLibrary } from "../store";
import world from "./world.json";

export function coordsOf(item: ItemView): [number, number] | null {
  const f = parseFields(item.fields);
  const lat = Number(f.lat);
  const lng = Number(f.lng);
  if (f.lat == null || f.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lat, lng];
}

export function MapPanel({ workspace }: PanelProps) {
  const t = useT();
  const { types } = useLibrary();
  const typeIds = useMemo(
    () =>
      types
        .filter(
          (d) => d.fields.some((f) => f.key === "lat") && d.fields.some((f) => f.key === "lng"),
        )
        .map((d) => d.id),
    [types],
  );
  const { data } = useLive<ItemView[]>(
    async () =>
      (
        await Promise.all(
          typeIds.map((typeId) =>
            api.itemList({
              typeId,
              states: ["active", "inbox", "archived"],
              container: null,
              tag: null,
              order: "updated",
              limit: null,
            }),
          ),
        )
      ).flat(),
    [],
    [typeIds.join()],
  );
  const [view, setView] = useState({ x: 0, y: 0, w: 360 });
  const grab = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const points = data.flatMap((i) => {
    const at = i.privacy === "confidential" ? null : coordsOf(i);
    return at ? [{ item: i, x: at[1] + 180, y: 90 - at[0] }] : [];
  });
  const h = view.w / 2;
  const unit = view.w / 360;
  return (
    <div className="dem-map">
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${h}`}
        role="img"
        aria-label={t("map.title")}
        onWheel={(e) => {
          const rect = svg.current?.getBoundingClientRect();
          if (!rect) return;
          const w = Math.min(360, Math.max(6, view.w * (e.deltaY > 0 ? 1.15 : 0.87)));
          const fx = (e.clientX - rect.left) / rect.width;
          const fy = (e.clientY - rect.top) / rect.height;
          setView({
            w,
            x: Math.min(360 - w, Math.max(0, view.x + fx * (view.w - w))),
            y: Math.min(180 - w / 2, Math.max(0, view.y + fy * (h - w / 2))),
          });
        }}
        onPointerDown={(e) => {
          grab.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const g = grab.current;
          const rect = svg.current?.getBoundingClientRect();
          if (!g || !rect) return;
          const scale = view.w / rect.width;
          setView({
            ...view,
            x: Math.min(360 - view.w, Math.max(0, g.vx - (e.clientX - g.x) * scale)),
            y: Math.min(180 - h, Math.max(0, g.vy - (e.clientY - g.y) * scale)),
          });
        }}
        onPointerUp={() => (grab.current = null)}
        onPointerLeave={() => (grab.current = null)}
      >
        <path d={world.path} className="dem-map-land" />
        {points.map(({ item, x, y }) => (
          <g
            key={item.id}
            transform={`translate(${x} ${y})`}
            onClick={() => openItem(workspace, t, item, { kind: "temp" })}
          >
            <circle r={unit * 4} className="dem-graph-hit" />
            <circle r={unit * 1.6} className="dem-map-point" />
            <text y={unit * -3} style={{ fontSize: unit * 5.5 }}>
              {titleOf(t, item)}
            </text>
          </g>
        ))}
      </svg>
      {!points.length && (
        <EmptyState icon="place" title={t("map.none")} description={t("map.how")} />
      )}
    </div>
  );
}
