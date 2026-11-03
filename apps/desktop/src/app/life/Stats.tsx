// 按月统计 for any type with a date and a number: one bar per month with its table right there, and
// what a month is made of underneath. A budget type with the same split shows how much is left.
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Select } from "../../ui/Select";
import { EmptyState } from "../../ui/States";
import type { PanelProps } from "../../workspace/registry";
import { api, parseFields } from "../api";
import { useLive } from "../live";
import { typeName } from "../model";
import { useLibrary } from "../store";
import { monthlySums, statsShape } from "./sums";

const figure = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function StatsPanel({ contentId }: PanelProps) {
  const t = useT();
  const { types } = useLibrary();
  const id = contentId.replace(/^stats:/, "");
  const def = types.find((x) => x.id === id);
  const list = (typeId: string) =>
    api.itemList({
      typeId,
      states: ["active", "inbox", "archived"],
      container: null,
      tag: null,
      order: "updated",
      limit: null,
    });
  const { data: items } = useLive<ItemView[]>(() => list(id), [], [id]);
  const { data: budgets } = useLive<ItemView[]>(() => list("budget"), []);
  const shape = def ? statsShape(def, (raw) => (def.builtin ? t(raw) : raw)) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  if (!def || !shape) return <EmptyState icon="kanban" title={t("stats.none")} />;

  // Money in and money out do not add up to anything: a direction field is a filter.
  const direction = shape.groups.find((g) => g.key === "direction");
  const splits = shape.groups.filter((g) => g !== direction);
  const split = splits.find((g) => g.key === picked) ?? splits[0] ?? null;
  const only = direction ? { key: "direction", value: "expense" } : undefined;
  const rows = monthlySums(items, shape, split?.key ?? null, only);
  const peak = Math.max(1, ...rows.map((r) => r.total));
  const current = rows.find((r) => r.month === month) ?? rows[0];
  const parts = current ? [...current.parts.entries()].sort((a, b) => b[1] - a[1]) : [];
  const budgetOf = (key: string) =>
    budgets.reduce((sum, b) => {
      const f = parseFields(b.fields);
      return split && f[split.key] === key ? sum + Number(f.amount ?? 0) : sum;
    }, 0);
  return (
    <div className="dem-stats">
      <header className="dem-life-head">
        <strong>{typeName(t, def)}</strong>
        <span className="dem-life-gap" />
        {splits.length > 1 && split && (
          <Select
            aria-label={t("stats.split")}
            selectedKey={split.key}
            onSelectionChange={(k) => setPicked(String(k))}
            options={splits.map((g) => ({ id: g.key, label: g.name }))}
          />
        )}
      </header>
      {!rows.length ? (
        <EmptyState icon="kanban" title={t("stats.empty")} />
      ) : (
        <>
          <table className="dem-stats-months">
            <tbody>
              {rows.slice(0, 18).map((r) => (
                <tr
                  key={r.month}
                  data-current={r === current ? "" : undefined}
                  onClick={() => setMonth(r.month)}
                >
                  <th scope="row">
                    <button type="button" onClick={() => setMonth(r.month)}>
                      {r.month}
                    </button>
                  </th>
                  <td className="dem-stats-bar">
                    <i style={{ width: `${(r.total / peak) * 100}%` }} />
                  </td>
                  <td className="dem-stats-num">{figure(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {split && current && (
            <table className="dem-stats-parts">
              <caption>{current.month}</caption>
              <thead>
                <tr>
                  <th scope="col">{split.name}</th>
                  <th scope="col">{t("stats.sum")}</th>
                  {budgets.length > 0 && <th scope="col">{t("stats.budget")}</th>}
                </tr>
              </thead>
              <tbody>
                {parts.map(([key, n]) => {
                  const budget = budgetOf(key);
                  return (
                    <tr key={key}>
                      <th scope="row">{split.labels.get(key) ?? (key || t("stats.other"))}</th>
                      <td className="dem-stats-num">{figure(n)}</td>
                      {budgets.length > 0 && (
                        <td
                          className="dem-stats-num"
                          data-over={budget > 0 && n > budget ? "" : undefined}
                        >
                          {budget > 0
                            ? n > budget
                              ? t("stats.over", { n: figure(n - budget) })
                              : t("stats.left", { n: figure(budget - n) })
                            : ""}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
