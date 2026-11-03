/* eslint-disable react-refresh/only-export-components -- the widgets and the data they draw on stay together */
// The home page's widgets on real data (docs/05-design.md §8). They are registered panels, so the
// same widget also works in a workspace cell.
import { useMemo } from "react";
import type { ActivityDay, ItemView, Reminder } from "../../bindings";
import { HeatMap } from "../../heatmap/HeatMap";
import { dateKey, parseDate, type HeatData, type HeatItem } from "../../heatmap/model";
import { useLocale, useT } from "../../i18n/context";
import type { StarGraph } from "../../home/starmap/graph";
import { Reminders, TodayTodos, type Todo } from "../../home/widgets";
import type { PanelProps } from "../../workspace/registry";
import { failed, HEATMAP_PANEL, openById } from "../actions";
import { openReview, WEEKLY_PANEL } from "./ReviewView";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { isoDate, levelOf, patch, titleOf } from "../model";
import { library, useLibrary, type LibraryData } from "../store";

const DAYS = 371;

export function useReminders() {
  return useLive<Reminder[]>(() => api.reminderList(), []);
}

export function RemindersPanel({ workspace }: PanelProps) {
  const t = useT();
  const locale = useLocale();
  const { data } = useReminders();
  const fmt = (r: Reminder) => {
    if (r.kind === "overdue" && r.when != null)
      return new Date(r.when).toLocaleDateString(locale, { month: "numeric", day: "numeric" });
    return t(`reminder.when.${r.kind}`);
  };
  return (
    <Reminders
      items={data.map((r) => ({
        id: r.id,
        title: r.title || t(`reminder.title.${r.kind}`),
        when: fmt(r),
      }))}
      onOpen={(id) => {
        if (id === "review:week")
          workspace.open({
            contentId: WEEKLY_PANEL,
            title: t("review.weekly"),
            component: WEEKLY_PANEL,
          });
        else if (id === "review:month" || id === "review:year")
          void openReview(workspace, t, id === "review:month" ? "month" : "year");
        else openById(workspace, t, id, { kind: "temp" });
      }}
    />
  );
}

/** Today's: what is due by today, then what is marked 下一步. 机密 items keep their titles out. */
export function todayTodos(t: (k: string) => string, items: ItemView[]): Todo[] {
  const today = isoDate(Date.now());
  const statusOf = (i: ItemView) => parseFields(i.fields).status;
  const dueToday = (i: ItemView) => i.due != null && isoDate(i.due) <= today;
  return items
    .filter((i) => i.typeId === "todo" && i.privacy !== "confidential")
    .filter((i) => statusOf(i) !== "someday" && statusOf(i) !== "waiting")
    .filter((i) => statusOf(i) !== "done" || (i.updated != null && isoDate(i.updated) === today))
    .sort((a, b) => Number(dueToday(b)) - Number(dueToday(a)))
    .map((i) => ({
      id: i.id,
      title: i.title || t("item.untitled"),
      done: statusOf(i) === "done",
    }));
}

export function TodosPanel() {
  const t = useT();
  const { items } = useLibrary();
  const todos = useMemo(() => todayTodos(t, items), [t, items]);
  return (
    <TodayTodos
      items={todos}
      onToggle={(id, done) =>
        void api
          .itemUpdate(id, patch({ fields: JSON.stringify({ status: done ? "done" : "next" }) }))
          .then(() => itemsChanged())
          .catch(failed(t, t("type.todo")))
      }
    />
  );
}

function useHeat(): HeatData {
  const start = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAYS + 1);
    return d;
  }, []);
  const { data } = useLive<ActivityDay[]>(async () => {
    const [own, commits] = await Promise.all([
      api.activitySince(dateKey(start)),
      api.gitActivity(dateKey(start)),
    ]);
    return [...own, ...commits];
  }, []);
  return useMemo(() => {
    const byDay = new Map<string, Record<string, number>>();
    const types = new Set<string>();
    for (const a of data) {
      types.add(a.typeId);
      byDay.set(a.date, { ...byDay.get(a.date), [a.typeId]: a.count });
    }
    const days = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const date = dateKey(d);
      return { date, counts: byDay.get(date) ?? {} };
    });
    return { days, types: [...types] };
  }, [data, start]);
}

function heatItemsOf(t: (k: string) => string, date: string): HeatItem[] {
  const day = parseDate(date);
  return library()
    .items.filter((i) => i.updated != null && dateKey(new Date(i.updated)) === dateKey(day))
    .map((i) => ({
      id: i.id,
      title: titleOf(t, i),
      type: i.typeId,
      privacy: levelOf(i.privacy),
    }));
}

export function HeatWidget({ workspace }: PanelProps) {
  const t = useT();
  const data = useHeat();
  return (
    <HeatMap
      data={data}
      itemsOf={(d) => heatItemsOf(t, d)}
      onOpen={(item) => openById(workspace, t, item.id, { kind: "temp" })}
      onExpand={(date) => {
        const id = workspace.open({
          contentId: HEATMAP_PANEL,
          component: HEATMAP_PANEL,
          title: t("heatmap.title"),
        });
        workspace.setTabParams(id, { date });
      }}
    />
  );
}

export function HeatPanel({ params, workspace }: PanelProps) {
  const t = useT();
  const data = useHeat();
  return (
    <div className="dem-heat-page">
      <HeatMap
        key={String(params.date)}
        data={data}
        itemsOf={(d) => heatItemsOf(t, d)}
        onOpen={(item) => openById(workspace, t, item.id, { kind: "temp" })}
        initialDay={typeof params.date === "string" ? params.date : null}
      />
    </div>
  );
}

const PRIVATE_CLUSTER = "private";

/**
 * The star map (§8): the item index with 机密 already left out by the core. 私密 items gather in
 * one unnamed cluster and show no titles there.
 */
export function starGraph(
  t: (k: string) => string,
  data: { items: ItemView[]; links: [string, string][] },
  tree: LibraryData["tree"],
): StarGraph {
  const parents = new Map(tree.map((n) => [n.id, n.parent]));
  const top = (id: string | null): string | undefined => {
    let at = id ?? undefined;
    const seen = new Set<string>();
    while (at && !seen.has(at)) {
      seen.add(at);
      const up = parents.get(at);
      if (!up) return at;
      at = up;
    }
    return at;
  };
  const isNode = new Set(tree.map((n) => n.id));
  const clusters = tree
    .filter((n) => !n.parent)
    .map((n) => ({
      id: n.id,
      name: n.privacy === "private" ? "" : n.title || t("item.untitled"),
      private: n.privacy === "private",
    }));
  const anyPrivate = data.items.some((i) => i.privacy === "private");
  if (anyPrivate) clusters.push({ id: PRIVATE_CLUSTER, name: "", private: true });
  return {
    clusters,
    nodes: data.items.map((i) => {
      const priv = i.privacy === "private";
      const cluster = top(isNode.has(i.id) ? i.id : i.container);
      return {
        id: i.id,
        title: priv ? "" : i.title || t("item.untitled"),
        cluster: priv
          ? cluster && parentIsPrivate(tree, cluster)
            ? cluster
            : PRIVATE_CLUSTER
          : cluster,
        hub: !parents.get(i.id) && isNode.has(i.id),
      };
    }),
    edges: data.links,
  };
}

function parentIsPrivate(tree: LibraryData["tree"], id: string) {
  return tree.find((n) => n.id === id)?.privacy === "private";
}
