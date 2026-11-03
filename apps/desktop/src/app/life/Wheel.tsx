// 平衡轮 (B6): how much each domain was touched lately. One petal per domain, one colour: length is
// the only thing that differs. The table says the same in numbers and names the quiet ones.
import { useMemo, useState } from "react";
import type { TreeNode } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/States";
import { askInWindow } from "../panels/AiPanels";
import { useLibrary } from "../store";

const DAYS = 30;
const DAY_MS = 86_400_000;
const QUIET_AFTER = 14;

export interface WheelRow {
  id: string;
  name: string;
  /** Only `normal` names may go to an AI chat without an authorised session. */
  open: boolean;
  recent: number;
  /** When something in it last changed; 0 for never. */
  last: number;
}

export function wheelRows(
  tree: Pick<TreeNode, "id" | "parent" | "kind" | "title" | "privacy">[],
  items: { id: string; container: string | null; updated: number | null; typeId: string }[],
  now: number,
  untitled: string,
): WheelRow[] {
  const parents = new Map(tree.map((n) => [n.id, n.parent]));
  const rootOf = (id: string | null) => {
    let at = id;
    const seen = new Set<string>();
    while (at && parents.get(at) && !seen.has(at)) {
      seen.add(at);
      at = parents.get(at) ?? null;
    }
    return at;
  };
  // 私密 and 机密 domains stay out: this page is one anyone looking over a shoulder can read.
  const rows = new Map(
    tree
      .filter(
        (n) =>
          !n.parent &&
          n.kind === "domain" &&
          n.privacy !== "private" &&
          n.privacy !== "confidential",
      )
      .map((n) => [
        n.id,
        { id: n.id, name: n.title || untitled, open: n.privacy === "normal", recent: 0, last: 0 },
      ]),
  );
  for (const i of items) {
    const root = rows.get(rootOf(i.container ?? i.id) ?? "");
    if (!root) continue;
    const updated = i.updated ?? 0;
    if (updated > now - DAYS * DAY_MS) root.recent++;
    root.last = Math.max(root.last, updated);
  }
  return [...rows.values()];
}

const petal = (cx: number, cy: number, r: number, a: number, b: number) => {
  const pt = (angle: number) => `${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)}`;
  return `M${cx} ${cy}L${pt(a)}A${r} ${r} 0 ${b - a > Math.PI ? 1 : 0} 1 ${pt(b)}Z`;
};

export function WheelPanel() {
  const t = useT();
  const { tree, items } = useLibrary();
  const [now] = useState(() => Date.now());
  const rows = useMemo(
    () => wheelRows(tree, items, now, t("item.untitled")),
    [tree, items, now, t],
  );
  if (!rows.length) return <EmptyState icon="folder" title={t("wheel.none")} />;
  const peak = Math.max(1, ...rows.map((r) => r.recent));
  const slice = (Math.PI * 2) / rows.length;
  const quiet = rows.filter((r) => now - r.last > QUIET_AFTER * DAY_MS);
  const ask = () =>
    void askInWindow(
      { session: "plain", mode: "chat", title: t("wheel.title") },
      t("wheel.ask", {
        list: rows
          .filter((r) => r.open)
          .map((r) => `${r.name}: ${r.recent}`)
          .join(", "),
        days: DAYS,
      }),
    );
  return (
    <div className="dem-wheel">
      <svg viewBox="0 0 320 320" role="img" aria-label={t("wheel.title")}>
        {[0.33, 0.66, 1].map((f) => (
          <circle key={f} cx={160} cy={160} r={130 * f} className="dem-wheel-ring" />
        ))}
        {rows.map((r, i) => {
          const a = i * slice - Math.PI / 2;
          const gap = rows.length > 1 ? 0.03 : 0;
          const radius = 12 + 118 * Math.sqrt(r.recent / peak);
          const mid = a + slice / 2;
          return (
            <g key={r.id}>
              <title>{`${r.name}: ${r.recent}`}</title>
              <path
                className="dem-wheel-petal"
                d={
                  rows.length === 1
                    ? `M160 ${160 - radius}A${radius} ${radius} 0 1 1 159.99 ${160 - radius}Z`
                    : petal(160, 160, radius, a + gap, a + slice - gap)
                }
              />
              <text
                x={160 + 146 * Math.cos(mid)}
                y={160 + 146 * Math.sin(mid)}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {r.name.slice(0, 6)}
              </text>
            </g>
          );
        })}
      </svg>
      <div>
        <table className="dem-stats-parts">
          <thead>
            <tr>
              <th scope="col">{t("wheel.domain")}</th>
              <th scope="col">{t("wheel.recent", { days: DAYS })}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.name}</th>
                <td className="dem-stats-num">{r.recent}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {quiet.length > 0 && (
          <p className="dem-life-none">
            {t("wheel.quiet", { list: quiet.map((r) => r.name).join("、") })}
          </p>
        )}
        <Button size="sm" icon="ai" onPress={ask}>
          {t("wheel.askButton")}
        </Button>
      </div>
    </div>
  );
}
