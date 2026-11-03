/* eslint-disable react-refresh/only-export-components -- helpers other panels call live with the view */
// 今天 (M5): a page for each day, a line whenever something comes up, and at the start of a month
// what was left over, to decide one by one. Nothing piles up: a day without a page is just empty.
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { refreshEditors } from "../../editor/pm/ProseEditor";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import { failed, newItem, openItem, trashItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { askInWindow } from "./AiPanels";
import { isoDate, patch, titleOf } from "../model";
import { library, useLibrary } from "../store";

const fieldOf = (i: ItemView, key: string) => {
  const v = parseFields(i.fields)[key];
  return typeof v === "string" ? v : "";
};

/** Today's page, made the first time it is asked for. */
export async function todayPage(): Promise<ItemView> {
  const day = isoDate(Date.now());
  const have = library().items.find((i) => i.typeId === "diary" && fieldOf(i, "date") === day);
  if (have) return have;
  const made = await api.itemCreate(
    // Lower than a diary's default, so the bullets can be read in a session you start (E6). Yours to raise.
    newItem({
      typeId: "diary",
      title: day,
      privacy: "sensitive",
      fields: JSON.stringify({ date: day }),
    }),
  );
  itemsChanged();
  return made;
}

/** 间隙日志: a line with the time. */
export async function logLine(text: string): Promise<void> {
  const page = await todayPage();
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  await api.bodyAppend(page.id, `${time} ${text}`);
  await refreshEditors(page.id);
  itemsChanged();
}

const MIGRATED_KEY = "ui-migrated";

function Migration({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const [month] = useState(() => isoDate(Date.now()).slice(0, 7));
  const { data: seen } = useLive<string[]>(
    async () => {
      try {
        const raw = JSON.parse((await api.localGet(MIGRATED_KEY)) ?? "{}") as {
          month?: string;
          ids?: string[];
        };
        return raw.month === month ? (raw.ids ?? []) : [];
      } catch {
        return [];
      }
    },
    [],
    [month],
  );
  const [done, setDone] = useState<string[]>([]);
  const left = items.filter(
    (i) =>
      i.typeId === "todo" &&
      fieldOf(i, "status") !== "done" &&
      i.created != null &&
      isoDate(i.created).slice(0, 7) < month &&
      !seen.includes(i.id) &&
      !done.includes(i.id),
  );
  if (!left.length) return null;
  const settled = (id: string) => {
    const ids = [...seen, ...done, id];
    setDone((d) => [...d, id]);
    void api.localSet(MIGRATED_KEY, JSON.stringify({ month, ids }));
  };
  const set = (i: ItemView, status: string) =>
    void api
      .itemUpdate(i.id, patch({ fields: JSON.stringify({ status }) }))
      .then(() => {
        settled(i.id);
        itemsChanged();
      })
      .catch(failed(t, t("today.migrate")));
  return (
    <section>
      <h3 className="dem-nav-group">{t("today.migrate")}</h3>
      <ul className="dem-nav-list">
        {left.slice(0, 20).map((i) => (
          <li key={i.id} className="dem-nav-row dem-nav-row-wrap">
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => openItem(workspace, t, i)}
            >
              <span className="dem-nav-title">{titleOf(t, i)}</span>
            </button>
            <span className="dem-nav-actions">
              <Button size="sm" variant="quiet" onPress={() => settled(i.id)}>
                {t("today.keep")}
              </Button>
              <Button size="sm" variant="quiet" onPress={() => set(i, "someday")}>
                {t("option.someday")}
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onPress={() => {
                  settled(i.id);
                  void trashItem(t, i).catch(failed(t, t("item.trash")));
                }}
              >
                {t("today.drop")}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DailyView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const [line, setLine] = useState("");
  const aiTask = async (task: string) => {
    const page = task === "bullets" || task === "gaplog" ? await todayPage() : null;
    const prompt = (await api.aiTaskPrompt(task)) ?? "";
    const first = `${prompt}\n\n${t("ai.prompt.lang")}${page ? `\n\n${t("ai.prompt.page", { id: page.id })}` : ""}`;
    await askInWindow(
      {
        // Today's page is 敏感, so only a session you start here reads it, and it has no web.
        session: page ? "authorized" : "plain",
        mode: "task",
        title: t(`ai.task.${task}`),
      },
      first,
    );
  };
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools">
        <TextField
          aria-label={t("today.log")}
          placeholder={t("today.log")}
          icon="edit"
          value={line}
          onChange={setLine}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !line.trim() || e.nativeEvent.isComposing) return;
            const text = line.trim();
            setLine("");
            void logLine(text)
              .then(() => showToast({ text: t("today.logged") }))
              .catch(failed(t, t("today.log")));
          }}
        />
      </div>
      <div className="dem-nav-tools">
        <Button
          size="sm"
          icon="book"
          onPress={() =>
            void todayPage()
              .then((p) => openItem(workspace, t, p, { kind: "temp" }))
              .catch(failed(t, t("today.open")))
          }
        >
          {t("today.open")}
        </Button>
      </div>
      <div className="dem-nav-tools dem-nav-tools-wrap">
        {(["bullets", "gaplog", "daily_plan", "evergreen"] as const).map((task) => (
          <Button
            key={task}
            size="sm"
            variant="quiet"
            icon="ai"
            onPress={() => void aiTask(task).catch(failed(t, t(`ai.task.${task}`)))}
          >
            {t(`ai.task.${task}`)}
          </Button>
        ))}
      </div>
      <Migration workspace={workspace} />
    </div>
  );
}
