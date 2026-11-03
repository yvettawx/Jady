/* eslint-disable react-refresh/only-export-components -- the weekly walk and what opens it stay together */
// 多层回顾 (PRD E4, M5): 日、周、月、年 each have a record, started by me. The weekly one is a walk
// through what needs deciding. A review skipped stays skipped.
import { useMemo, useState } from "react";
import type { ActivityDay, ItemView } from "../../bindings";
import { useProposals } from "../../ai/context";
import { ProposalCard } from "../../ai/ProposalCard";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import type { WorkspaceApi } from "../../workspace/api";
import type { PanelProps } from "../../workspace/registry";
import { failed, newItem, openById, openItem, trashItem } from "../actions";
import { askInWindow } from "./AiPanels";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { isoDate, patch, titleOf } from "../model";
import { library, useLibrary } from "../store";

export const WEEKLY_PANEL = "weekly-review";
export type Period = "day" | "week" | "month" | "year";

const field = (i: ItemView, key: string) => {
  const v = parseFields(i.fields)[key];
  return typeof v === "string" ? v : "";
};

export const periodStart = (period: Period, now = new Date()) => {
  const d = new Date(now);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === "month") d.setDate(1);
  if (period === "year") d.setMonth(0, 1);
  return isoDate(d.getTime());
};

export async function openReview(
  ws: WorkspaceApi,
  t: (k: string, v?: Record<string, string | number>) => string,
  period: Period,
  extra = "",
) {
  const since = periodStart(period);
  const have = library().items.find(
    (i) => i.typeId === "review" && field(i, "period") === period && field(i, "date") >= since,
  );
  const item =
    have ??
    (await api.itemCreate(
      newItem({
        typeId: "review",
        title: t(`review.title.${period}`, { date: since }),
        fields: JSON.stringify({ period, date: isoDate(Date.now()) }),
        markdown: `${extra}${t(`review.template.${period}`)}`,
      }),
    ));
  itemsChanged();
  openItem(ws, t, item, { kind: "temp" });
  return item;
}

/** 回顾起草 (E4): a session you start, on a record that is 敏感 by default. */
export async function draftReview(
  ws: WorkspaceApi,
  t: (k: string, v?: Record<string, string | number>) => string,
  period: Period,
) {
  const item = await openReview(ws, t, period);
  const prompt = (await api.aiTaskPrompt("review_draft")) ?? "";
  await askInWindow(
    { session: "authorized", mode: "task", title: t("ai.task.review_draft") },
    `${prompt}\n\n${t("ai.prompt.lang")}\n\n${t("ai.prompt.review", { id: item.id, period: t(`review.period.${period}`) })}`,
  );
}

export function ReviewView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const past = items
    .filter((i) => i.typeId === "review")
    .sort((a, b) => field(b, "date").localeCompare(field(a, "date")));
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools dem-nav-tools-wrap">
        <Button
          size="sm"
          variant="primary"
          onPress={() =>
            workspace.open({
              contentId: WEEKLY_PANEL,
              title: t("review.weekly"),
              component: WEEKLY_PANEL,
            })
          }
        >
          {t("review.weekly")}
        </Button>
        {(["day", "month", "year"] as Period[]).map((p) => (
          <Button
            key={p}
            size="sm"
            onPress={() => void openReview(workspace, t, p).catch(failed(t, t("review.weekly")))}
          >
            {t(`review.period.${p}`)}
          </Button>
        ))}
        <Button
          size="sm"
          variant="quiet"
          icon="ai"
          onPress={() =>
            void draftReview(workspace, t, "week").catch(failed(t, t("ai.task.review_draft")))
          }
        >
          {t("ai.task.review_draft")}
        </Button>
      </div>
      <ul className="dem-nav-list">
        {past.map((i) => (
          <li key={i.id} className="dem-nav-row">
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => openItem(workspace, t, i)}
            >
              <span className="dem-nav-title">{titleOf(t, i)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STEPS = ["inbox", "todos", "soon", "proposals", "week", "notes"] as const;

function ProposalsStep({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items, store } = useProposals();
  const pending = items.filter((p) => p.state === "pending");
  return (
    <>
      <div className="dem-nav-tools dem-nav-tools-wrap">
        <Button
          size="sm"
          icon="ai"
          onPress={() =>
            void api
              .aiTaskPrompt("maintain")
              .then((prompt) =>
                askInWindow(
                  { session: "plain", mode: "task", title: t("ai.task.maintain") },
                  `${prompt ?? ""}\n\n${t("ai.prompt.lang")}`,
                ),
              )
              .catch(failed(t, t("ai.task.maintain")))
          }
        >
          {t("ai.task.maintain")}
        </Button>
        {pending.length > 1 && (
          <Button size="sm" onPress={() => store.confirmAll()}>
            {t("ai.proposals.confirmAll")}
          </Button>
        )}
      </div>
      {!pending.length && <EmptyState icon="proposal" title={t("ai.proposals.none")} />}
      {pending.map((p) => (
        <ProposalCard
          key={p.id}
          id={p.id}
          onOpen={(id) => openById(workspace, t, id, { kind: "temp" })}
        />
      ))}
    </>
  );
}

/** Extra steps other modules add to the walk (the AI's proposals, from P3). */
const extraSteps = new Map<string, () => React.ReactNode>();
export function registerWeeklyStep(id: string, render: () => React.ReactNode) {
  extraSteps.set(id, render);
  return () => {
    extraSteps.delete(id);
  };
}

function Row({
  item,
  workspace,
  children,
}: {
  item: ItemView;
  workspace: WorkspaceApi;
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <li className="dem-flow-row">
      <button type="button" className="dem-nav-open" onClick={() => openItem(workspace, t, item)}>
        <span className="dem-nav-title">{titleOf(t, item)}</span>
      </button>
      <span className="dem-nav-actions">{children}</span>
    </li>
  );
}

export function WeeklyReviewPanel({ workspace }: PanelProps) {
  const t = useT();
  const { items } = useLibrary();
  const [at, setAt] = useState(0);
  const [notes, setNotes] = useState("");
  const [focus, setFocus] = useState("");
  const update = (id: string, p: ReturnType<typeof patch>) =>
    void api
      .itemUpdate(id, p)
      .then(() => itemsChanged())
      .catch(failed(t, t("review.weekly")));
  const steps = [...STEPS, ...extraSteps.keys()];
  const step = steps[Math.min(at, steps.length - 1)] ?? "inbox";
  const [now] = useState(() => Date.now());
  const weekAgo = isoDate(now - 7 * 86_400_000);
  const inbox = items.filter((i) => i.state === "inbox");
  const todos = items.filter((i) => i.typeId === "todo" && field(i, "status") !== "done");
  const soon = todos.filter((i) => {
    if (i.due == null) return false;
    const near = i.due - now < 7 * 86_400_000;
    const untouched = i.updated != null && now - i.updated > 7 * 86_400_000;
    return near && untouched;
  });
  const { data: activity } = useLive<ActivityDay[]>(
    () => api.activitySince(weekAgo),
    [],
    [weekAgo],
  );
  const edits = useMemo(() => activity.reduce((n, a) => n + a.count, 0), [activity]);
  const finished = items.filter(
    (i) =>
      i.typeId === "todo" &&
      field(i, "status") === "done" &&
      i.updated != null &&
      isoDate(i.updated) >= weekAgo,
  );
  const finish = () => {
    const summary = t("review.summary", { edits, done: finished.length });
    const extra = `${summary}\n\n${notes ? `${notes}\n\n` : ""}${focus ? `${t("review.focus")}: ${focus}\n\n` : ""}`;
    void openReview(workspace, t, "week", extra).catch(failed(t, t("review.weekly")));
  };
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head">
        <h1>{t("review.weekly")}</h1>
        <ol className="dem-flow-steps">
          {steps.map((s, i) => (
            <li key={s} aria-current={i === at ? "step" : undefined}>
              {t(`review.step.${s}`)}
            </li>
          ))}
        </ol>
      </header>
      <div className="dem-flow-body">
        {step === "inbox" &&
          (inbox.length ? (
            <ul className="dem-flow-list">
              {inbox.map((i) => (
                <Row key={i.id} item={i} workspace={workspace}>
                  <Button size="sm" onPress={() => update(i.id, patch({ state: "active" }))}>
                    {t("nav.inbox.file")}
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    onPress={() => void trashItem(t, i).catch(failed(t, t("item.trash")))}
                  >
                    {t("today.drop")}
                  </Button>
                </Row>
              ))}
            </ul>
          ) : (
            <EmptyState icon="inbox" title={t("nav.inbox.empty")} />
          ))}
        {step === "todos" &&
          (todos.length ? (
            <ul className="dem-flow-list">
              {todos.map((i) => (
                <Row key={i.id} item={i} workspace={workspace}>
                  {["next", "waiting", "someday", "done"].map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={field(i, "status") === s ? "primary" : "quiet"}
                      onPress={() => update(i.id, patch({ fields: JSON.stringify({ status: s }) }))}
                    >
                      {t(`option.${s}`)}
                    </Button>
                  ))}
                </Row>
              ))}
            </ul>
          ) : (
            <EmptyState icon="todo" title={t("home.todos.empty")} />
          ))}
        {step === "soon" &&
          (soon.length ? (
            <ul className="dem-flow-list">
              {soon.map((i) => (
                <Row key={i.id} item={i} workspace={workspace} />
              ))}
            </ul>
          ) : (
            <EmptyState icon="calendar" title={t("review.soon.none")} />
          ))}
        {step === "proposals" && <ProposalsStep workspace={workspace} />}
        {step === "week" && (
          <p className="dem-flow-note">{t("review.summary", { edits, done: finished.length })}</p>
        )}
        {step === "notes" && (
          <div className="dem-flow-form">
            <label className="dem-field-label" htmlFor="dem-week-notes">
              {t("review.notes")}
            </label>
            <textarea
              id="dem-week-notes"
              className="dem-flow-text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <TextField label={t("review.focus")} value={focus} onChange={setFocus} />
          </div>
        )}
        {extraSteps.get(step)?.()}
      </div>
      <footer className="dem-flow-foot">
        <Button variant="quiet" isDisabled={at === 0} onPress={() => setAt(at - 1)}>
          {t("action.back")}
        </Button>
        {at < steps.length - 1 ? (
          <Button variant="primary" onPress={() => setAt(at + 1)}>
            {t("action.next")}
          </Button>
        ) : (
          <Button variant="primary" onPress={finish}>
            {t("review.finish")}
          </Button>
        )}
      </footer>
    </div>
  );
}
