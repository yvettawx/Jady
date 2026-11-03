// 习惯打卡 (G1). A habit and a check-in are ordinary items, so check-ins reach the heat map like
// anything else that is made. This view only reads and adds them.
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import type { PanelProps } from "../../workspace/registry";
import { failed, newItem, openItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { isoDate, patch, titleOf } from "../model";
import { streakOf } from "./sums";

const list = (typeId: string) =>
  api.itemList({
    typeId,
    states: ["active"],
    container: null,
    tag: null,
    order: "created",
    limit: null,
  });

export function HabitsWidget({ workspace }: PanelProps) {
  const t = useT();
  const { data: habits } = useLive<ItemView[]>(() => list("habit"), []);
  const { data: logs } = useLive<ItemView[]>(() => list("habit_log"), []);
  const [today] = useState(() => isoDate(Date.now()));
  if (!habits.length) return <p className="dem-life-none">{t("habit.none")}</p>;
  const toggle = (habit: ItemView, done: ItemView | undefined) => {
    const work = done
      ? api.itemUpdate(done.id, patch({ state: "trashed" }))
      : api.itemCreate(
          newItem({
            typeId: "habit_log",
            title: habit.title,
            fields: JSON.stringify({ habit: habit.id, date: today }),
          }),
        );
    void work.then(() => itemsChanged()).catch(failed(t, t("habit.title")));
  };
  return (
    <ul className="dem-life-list">
      {habits.map((h) => {
        const own = logs.filter((l) => parseFields(l.fields).habit === h.id);
        const days = own.map((l) => String(parseFields(l.fields).date));
        const done = own.find((l) => parseFields(l.fields).date === today);
        const streak = streakOf(days, today);
        return (
          <li key={h.id} className="dem-habit">
            <input
              type="checkbox"
              aria-label={t("habit.check", { title: titleOf(t, h) })}
              checked={!!done}
              onChange={() => toggle(h, done)}
            />
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => openItem(workspace, t, h, { kind: "temp" })}
            >
              <span className="dem-nav-title">{titleOf(t, h)}</span>
              {streak > 0 && (
                <span className="dem-nav-count">{t("heatmap.streak", { n: streak })}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
