// AI 定期任务 (D11): a prompt that runs by itself while the app is open. Always a plain session, so
// 敏感 and above are out of its sight whatever the prompt says. The answer lands in the inbox, marked
// as AI's and to be checked, and nothing else changes. With the dedicated browser on, what it would
// send waits for you; unanswered, it is kept in the list here (waiting.ts).
import { useEffect, useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import type { Translate } from "../../i18n/messages";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import type { PanelProps } from "../../workspace/registry";
import { failed, newItem, openItem } from "../actions";
import { endChat, sendChat, startChat } from "../ai/chats";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { isoDate, patch, titleOf } from "../model";
import { isDue } from "./scheduleRule";
import { dropWaiting, setRunningTask, useWaiting } from "./waiting";

export const SCHEDULED_PANEL = "scheduled";
const CHECK_EVERY = 60_000;

const listTasks = () =>
  api.itemList({
    typeId: "scheduled_task",
    states: ["active"],
    container: null,
    tag: null,
    order: "created",
    limit: null,
  });

let running = false;

export async function runTask(t: Translate, task: ItemView): Promise<ItemView | null> {
  const status = await api.aiStatus();
  if (!status.current) return null;
  const prompt = (await api.bodyMarkdown(task.id)).trim();
  if (!prompt) return null;
  const title = titleOf(t, task);
  const chat = await startChat({ session: "plain", mode: "chat", title });
  setRunningTask({ id: task.id, title });
  const answer = await sendChat(chat, prompt).finally(() => {
    setRunningTask(null);
    return endChat(chat, null, []);
  });
  await api.itemUpdate(
    task.id,
    patch({ fields: JSON.stringify({ last_run: new Date().toISOString() }) }),
  );
  if (!answer.trim()) return null;
  const made = await api.itemCreate(
    newItem({
      typeId: "note",
      title: `${title} ${isoDate(Date.now())}`,
      state: "inbox",
      markdown: answer,
    }),
  );
  await api.itemUpdate(
    made.id,
    patch({
      source: { origin: "aiSearch", needsCheck: true, conflict: false, recheckOn: null, refs: [] },
    }),
  );
  itemsChanged();
  return made;
}

/** Called every minute. One at a time, and only for tasks left at the normal privacy level. */
export async function runDueTasks(t: Translate, now = new Date()) {
  if (running) return;
  running = true;
  try {
    for (const task of await listTasks())
      if (task.privacy === "normal" && isDue(parseFields(task.fields), now)) await runTask(t, task);
  } finally {
    running = false;
  }
}

export function useScheduledTasks() {
  const t = useT();
  useEffect(() => {
    const go = () => void runDueTasks(t).catch(() => undefined);
    const timer = setInterval(go, CHECK_EVERY);
    return () => clearInterval(timer);
  }, [t]);
}

export function ScheduledPanel({ workspace }: PanelProps) {
  const t = useT();
  const { data: tasks } = useLive<ItemView[]>(listTasks, []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const waiting = useWaiting();
  const run = (task: ItemView) => {
    setBusy(task.id);
    void dropWaiting(task.id)
      .then(() => runTask(t, task))
      .then((made) => made && openItem(workspace, t, made, { kind: "temp" }))
      .catch(failed(t, t("scheduled.title")))
      .finally(() => setBusy(null));
  };
  const set = (id: string, fields: object) =>
    void api
      .itemUpdate(id, patch({ fields: JSON.stringify(fields) }))
      .then(() => itemsChanged())
      .catch(failed(t, t("scheduled.title")));
  return (
    <div className="dem-stats">
      <header className="dem-life-head">
        <strong>{t("scheduled.title")}</strong>
      </header>
      <p className="dem-life-none">{t("scheduled.about")}</p>
      <form
        className="dem-life-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const title = name.trim();
          setName("");
          void api
            .itemCreate(
              newItem({
                typeId: "scheduled_task",
                title,
                fields: JSON.stringify({ frequency: "weekly", at: "09:00" }),
              }),
            )
            .then((made) => {
              itemsChanged();
              openItem(workspace, t, made, { kind: "temp" });
            })
            .catch(failed(t, t("scheduled.title")));
        }}
      >
        <TextField
          aria-label={t("scheduled.new")}
          placeholder={t("scheduled.new")}
          value={name}
          onChange={setName}
        />
      </form>
      {waiting.length > 0 && (
        <section className="dem-scheduled-waiting" aria-label={t("scheduled.waiting")}>
          <h3 className="dem-nav-group">{t("scheduled.waiting")}</h3>
          <ul className="dem-scheduled">
            {waiting.map((w) => {
              const task = tasks.find((x) => x.id === w.taskId);
              return (
                <li key={`${w.id}-${w.at}`}>
                  <span className="dem-nav-title">{w.title}</span>
                  <code className="dem-browser-request">{`${w.method} ${w.host}`}</code>
                  {task && (
                    <Button
                      size="sm"
                      variant="primary"
                      isDisabled={busy !== null}
                      onPress={() => run(task)}
                    >
                      {t("scheduled.run")}
                    </Button>
                  )}
                  <Button size="sm" variant="quiet" onPress={() => void dropWaiting(w.taskId)}>
                    {t("scheduled.drop")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {!tasks.length && <EmptyState icon="ai" title={t("scheduled.none")} />}
      <ul className="dem-scheduled">
        {tasks.map((task) => {
          const f = parseFields(task.fields);
          const last = typeof f.last_run === "string" ? isoDate(Date.parse(f.last_run)) : null;
          return (
            <li key={task.id}>
              <button
                type="button"
                className="dem-nav-open"
                onClick={() => openItem(workspace, t, task, { kind: "temp" })}
              >
                <span className="dem-nav-title">{titleOf(t, task)}</span>
                <span className="dem-nav-count">
                  {last ? t("scheduled.last", { date: last }) : t("scheduled.never")}
                </span>
              </button>
              <Select
                aria-label={t("field.frequency")}
                selectedKey={typeof f.frequency === "string" ? f.frequency : "weekly"}
                onSelectionChange={(k) => set(task.id, { frequency: String(k) })}
                options={["daily", "weekly", "monthly"].map((id) => ({
                  id,
                  label: t(`option.${id}`),
                }))}
              />
              <Button
                size="sm"
                variant="quiet"
                onPress={() => set(task.id, { paused: f.paused !== true })}
              >
                {t(f.paused === true ? "scheduled.resume" : "scheduled.pause")}
              </Button>
              <Button size="sm" isDisabled={busy !== null} onPress={() => run(task)}>
                {t("scheduled.run")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
