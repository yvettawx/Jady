// 关系图 (B4): the links between items, drawn flat. 私密 items keep no name here, and 机密 are not
// in the data at all, the same as on the star map.
import { useMemo, useState } from "react";
import type { GraphData } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/States";
import type { PanelProps } from "../../workspace/registry";
import { openById } from "../actions";
import { api } from "../api";
import { useLive } from "../live";

const ENTITIES = new Set(["person", "place", "event", "organization"]);
const SIZE = 800;

export interface Placed {
  id: string;
  x: number;
  y: number;
}

/** A plain force layout. Starts from a fixed spiral, so the same data lands in the same place. */
export function layoutGraph(ids: string[], edges: [string, string][], rounds = 220): Placed[] {
  const nodes = ids.map((id, i) => {
    const angle = i * 2.39996;
    const r = 18 * Math.sqrt(i + 1);
    return {
      id,
      x: SIZE / 2 + r * Math.cos(angle),
      y: SIZE / 2 + r * Math.sin(angle),
      dx: 0,
      dy: 0,
    };
  });
  const at = new Map(nodes.map((n) => [n.id, n]));
  const lines = edges.flatMap(([a, b]) => {
    const p = at.get(a);
    const q = at.get(b);
    return p && q && p !== q ? [[p, q] as const] : [];
  });
  const ideal = SIZE / (2 + Math.sqrt(nodes.length));
  for (let round = 0; round < rounds; round++) {
    const heat = 1 - round / rounds;
    for (const n of nodes) {
      n.dx = (SIZE / 2 - n.x) * 0.01;
      n.dy = (SIZE / 2 - n.y) * 0.01;
    }
    nodes.forEach((p, i) => {
      for (const q of nodes.slice(i + 1)) {
        const x = p.x - q.x;
        const y = p.y - q.y;
        const d2 = Math.max(x * x + y * y, 1);
        const push = (ideal * ideal) / d2;
        p.dx += x * push * 0.05;
        p.dy += y * push * 0.05;
        q.dx -= x * push * 0.05;
        q.dy -= y * push * 0.05;
      }
    });
    for (const [p, q] of lines) {
      const x = p.x - q.x;
      const y = p.y - q.y;
      const pull = Math.hypot(x, y) / ideal;
      p.dx -= x * pull * 0.05;
      p.dy -= y * pull * 0.05;
      q.dx += x * pull * 0.05;
      q.dy += y * pull * 0.05;
    }
    for (const n of nodes) {
      const len = Math.hypot(n.dx, n.dy) || 1;
      const step = Math.min(len, 24 * heat + 0.5);
      n.x = Math.min(SIZE - 30, Math.max(30, n.x + (n.dx / len) * step));
      n.y = Math.min(SIZE - 30, Math.max(30, n.y + (n.dy / len) * step));
    }
  }
  return nodes.map(({ id, x, y }) => ({ id, x, y }));
}

export function GraphPanel({ workspace }: PanelProps) {
  const t = useT();
  const { data } = useLive<GraphData | null>(() => api.graphData(), null);
  const [everything, setEverything] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const { nodes, edges, placed } = useMemo(() => {
    const items = (data?.items ?? []).filter((i) => everything || ENTITIES.has(i.typeId));
    const ids = new Set(items.map((i) => i.id));
    const lines = (data?.links ?? []).filter(([a, b]) => ids.has(a) && ids.has(b));
    // Without the links, a library of thousands is a crowd: keep what is connected.
    const linked = new Set(lines.flat());
    const shown = everything ? items.filter((i) => linked.has(i.id)).slice(0, 300) : items;
    return {
      nodes: shown,
      edges: lines,
      placed: new Map(
        layoutGraph(
          shown.map((i) => i.id),
          lines,
        ).map((p) => [p.id, p]),
      ),
    };
  }, [data, everything]);
  const degree = useMemo(() => {
    const out = new Map<string, number>();
    for (const [a, b] of edges) {
      out.set(a, (out.get(a) ?? 0) + 1);
      out.set(b, (out.get(b) ?? 0) + 1);
    }
    return out;
  }, [edges]);
  const near = new Set(
    hover ? edges.flatMap(([a, b]) => (a === hover ? [b] : b === hover ? [a] : [])) : [],
  );
  return (
    <div className="dem-graph">
      <header className="dem-life-head">
        <Button
          size="sm"
          variant={everything ? "quiet" : "secondary"}
          onPress={() => setEverything(false)}
        >
          {t("graph.entities")}
        </Button>
        <Button
          size="sm"
          variant={everything ? "secondary" : "quiet"}
          onPress={() => setEverything(true)}
        >
          {t("graph.everything")}
        </Button>
      </header>
      {!nodes.length ? (
        <EmptyState icon="link" title={t("graph.none")} />
      ) : (
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={t("graph.title")}>
          {edges.map(([a, b]) => {
            const p = placed.get(a);
            const q = placed.get(b);
            if (!p || !q) return null;
            return (
              <line
                key={`${a}-${b}`}
                x1={p.x}
                y1={p.y}
                x2={q.x}
                y2={q.y}
                data-near={hover === a || hover === b ? "" : undefined}
              />
            );
          })}
          {nodes.map((n) => {
            const p = placed.get(n.id);
            if (!p) return null;
            const secret = n.privacy === "private";
            const name = secret ? "" : n.title || t("item.untitled");
            const r = 4 + Math.min(8, degree.get(n.id) ?? 0);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                data-dim={hover && hover !== n.id && !near.has(n.id) ? "" : undefined}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
                onClick={() => openById(workspace, t, n.id, { kind: "temp" })}
              >
                <circle r={r + 8} className="dem-graph-hit" />
                <circle r={r} />
                <text y={r + 13}>{name}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
