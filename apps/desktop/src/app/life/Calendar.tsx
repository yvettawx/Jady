// 日程 (E2): a week of hours and a month of days. Blocks are `schedule` items with a time span; a
// to-do dragged in becomes one, so its due date stays its own.
import { useEffect, useRef, useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import type { PanelProps } from "../../workspace/registry";
import { failed, newItem, openItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { isoDate, patch, titleOf } from "../model";

/** The bindings allow null for any float; the core always sends these. */
interface Entry {
  item: ItemView;
  start: number;
  end: number;
}
const loadEntries = async (from: number, to: number): Promise<Entry[]> =>
  (await api.agenda(from, to)).map((e) => ({
    item: e.item,
    start: e.start ?? 0,
    end: e.end ?? 0,
  }));
const spanOf = (item: ItemView) =>
  item.span ? { ...item.span, start: item.span.start ?? 0, end: item.span.end ?? 0 } : null;

const HOUR = 44;
const STEP = 15 * 60_000;
const HOUR_MS = 3_600_000;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const atMidnight = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (d: Date, n: number) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};
const mondayOf = (d: Date) => addDays(atMidnight(d.getTime()), -((d.getDay() + 6) % 7));
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const nextHour = () => Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
const useToday = () => useState(() => isoDate(Date.now()))[0];

export async function placeBlock(title: string, start: number, end: number, todo?: string) {
  const made = await api.itemCreate(
    newItem({
      typeId: "schedule",
      title,
      fields: todo ? JSON.stringify({ todo }) : null,
    }),
  );
  await api.itemUpdate(made.id, patch({ span: { start, end, tz: zone(), recurrence: null } }));
  itemsChanged();
}

/** Where a pointer is on the grid, to the nearest quarter hour; nothing when it is outside. */
function slotAt(x: number, y: number): number | null {
  const col = document
    .elementsFromPoint(x, y)
    .find((e): e is HTMLElement => e instanceof HTMLElement && !!e.dataset.dayStart);
  if (!col) return null;
  const top = col.getBoundingClientRect().top;
  const raw = Number(col.dataset.dayStart) + ((y - top) / HOUR) * HOUR_MS;
  return Math.round(raw / STEP) * STEP;
}

type Drag =
  | { kind: "move"; entry: Entry; grabbed: number; at: number; moved: boolean }
  | { kind: "size"; entry: Entry; at: number }
  | { kind: "new"; from: number; at: number }
  | { kind: "todo"; todo: ItemView; x: number; y: number; at: number | null };

function Block({
  entry,
  top,
  height,
  drag,
  onPress,
}: {
  entry: Entry;
  top: number;
  height: number;
  drag: Drag | null;
  onPress: (e: React.PointerEvent, kind: "move" | "size") => void;
}) {
  const t = useT();
  const live = drag && "entry" in drag && drag.entry === entry;
  return (
    <div
      className="dem-cal-block"
      data-dragging={live ? "" : undefined}
      style={{ top, height }}
      onPointerDown={(e) => onPress(e, "move")}
    >
      <span className="dem-cal-time">{clock(entry.start)}</span>
      <span className="dem-cal-title">{titleOf(t, entry.item)}</span>
      {!entry.item.span?.recurrence && (
        <i className="dem-cal-size" onPointerDown={(e) => onPress(e, "size")} />
      )}
    </div>
  );
}

export function CalendarPanel({ workspace }: PanelProps) {
  const t = useT();
  const today = useToday();
  const [mode, setMode] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const [name, setName] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const from = mode === "week" ? mondayOf(anchor) : mondayOf(monthStart);
  const dayCount = mode === "week" ? 7 : 42;
  const days = Array.from({ length: dayCount }, (_, i) => addDays(from, i));
  const to = addDays(from, dayCount).getTime();
  const { data: entries } = useLive<Entry[]>(
    () => loadEntries(from.getTime(), to),
    [],
    [from.getTime(), to],
  );
  const { data: todos } = useLive<ItemView[]>(
    async () =>
      (
        await api.itemList({
          typeId: "todo",
          states: ["active", "inbox"],
          container: null,
          tag: null,
          order: "due",
          limit: 40,
        })
      ).filter((i) => parseFields(i.fields).status !== "done"),
    [],
  );

  useEffect(() => {
    if (mode === "week" && scroller.current) scroller.current.scrollTop = HOUR * 8;
  }, [mode]);

  const set = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const finish = async (d: Drag) => {
    if (d.kind === "new") {
      const [a, b] = d.from <= d.at ? [d.from, d.at] : [d.at, d.from];
      setName("");
      setDraft({ start: a, end: b > a ? b : a + HOUR_MS });
    } else if (d.kind === "todo") {
      if (d.at != null) await placeBlock(titleOf(t, d.todo), d.at, d.at + HOUR_MS, d.todo.id);
    } else if (d.kind === "move") {
      if (!d.moved) {
        openItem(workspace, t, d.entry.item, { kind: "temp" });
        return;
      }
      const span = spanOf(d.entry.item);
      if (!span || span.recurrence) return;
      const by = d.at - d.grabbed;
      await api.itemUpdate(
        d.entry.item.id,
        patch({ span: { ...span, start: span.start + by, end: span.end + by } }),
      );
      itemsChanged();
    } else {
      const span = spanOf(d.entry.item);
      if (!span) return;
      await api.itemUpdate(
        d.entry.item.id,
        patch({ span: { ...span, end: Math.max(d.at, span.start + STEP) } }),
      );
      itemsChanged();
    }
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const at = slotAt(e.clientX, e.clientY);
      if (d.kind === "todo") set({ ...d, x: e.clientX, y: e.clientY, at });
      else if (at != null)
        set({ ...d, at, ...(d.kind === "move" ? { moved: d.moved || at !== d.grabbed } : {}) });
    };
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      set(null);
      void finish(d).catch(failed(t, t("calendar.title")));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  const press = (e: React.PointerEvent, entry: Entry, kind: "move" | "size") => {
    e.stopPropagation();
    e.preventDefault();
    const at = slotAt(e.clientX, e.clientY) ?? entry.start;
    set(kind === "move" ? { kind, entry, grabbed: at, at, moved: false } : { kind, entry, at });
  };

  const shift = (n: number) =>
    setAnchor((a) =>
      mode === "week" ? addDays(a, 7 * n) : new Date(a.getFullYear(), a.getMonth() + n, 1),
    );

  const heading =
    mode === "week"
      ? `${isoDate(from.getTime())} ${t("calendar.weekOf")}`
      : monthStart.toLocaleDateString(undefined, { year: "numeric", month: "long" });

  return (
    <div className="dem-cal">
      <header className="dem-life-head">
        <Button
          size="sm"
          variant="quiet"
          icon="back"
          aria-label={t("calendar.prev")}
          onPress={() => shift(-1)}
        />
        <Button size="sm" variant="quiet" onPress={() => setAnchor(new Date())}>
          {t("calendar.today")}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          icon="chevron-right"
          aria-label={t("calendar.next")}
          onPress={() => shift(1)}
        />
        <strong>{heading}</strong>
        <span className="dem-life-gap" />
        <Button
          size="sm"
          variant={mode === "week" ? "secondary" : "quiet"}
          onPress={() => setMode("week")}
        >
          {t("calendar.week")}
        </Button>
        <Button
          size="sm"
          variant={mode === "month" ? "secondary" : "quiet"}
          onPress={() => setMode("month")}
        >
          {t("calendar.month")}
        </Button>
      </header>
      {draft && (
        <form
          className="dem-life-form"
          onSubmit={(e) => {
            e.preventDefault();
            const { start, end } = draft;
            setDraft(null);
            void placeBlock(name.trim(), start, end).catch(failed(t, t("calendar.title")));
          }}
        >
          <span>{`${clock(draft.start)} – ${clock(draft.end)}`}</span>
          <TextField
            autoFocus
            aria-label={t("calendar.blockName")}
            placeholder={t("calendar.blockName")}
            value={name}
            onChange={setName}
          />
          <Button type="submit" size="sm" variant="primary">
            {t("calendar.add")}
          </Button>
          <Button size="sm" variant="quiet" onPress={() => setDraft(null)}>
            {t("calendar.cancel")}
          </Button>
        </form>
      )}
      <div className="dem-cal-body">
        {mode === "week" ? (
          <div className="dem-cal-week" ref={scroller}>
            <div className="dem-cal-days">
              <span />
              {days.map((d) => (
                <span
                  key={d.getTime()}
                  data-today={isoDate(d.getTime()) === today ? "" : undefined}
                >
                  {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
                </span>
              ))}
            </div>
            <div className="dem-cal-grid">
              <div className="dem-cal-hours">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} style={{ height: HOUR }}>{`${h}:00`}</span>
                ))}
              </div>
              {days.map((d) => {
                const start = d.getTime();
                const end = addDays(d, 1).getTime();
                const here = entries.filter((e) => e.start < end && e.end > start);
                const preview = drag && (drag.kind === "new" || drag.kind === "todo") ? drag : null;
                const pa =
                  preview?.kind === "new"
                    ? Math.min(preview.from, preview.at)
                    : (preview?.at ?? null);
                const pb =
                  preview?.kind === "new"
                    ? Math.max(preview.from, preview.at)
                    : pa != null
                      ? pa + HOUR_MS
                      : null;
                return (
                  <div
                    key={start}
                    className="dem-cal-col"
                    data-day-start={start}
                    style={{ height: HOUR * 24 }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      const at = slotAt(e.clientX, e.clientY);
                      if (at != null) set({ kind: "new", from: at, at });
                    }}
                  >
                    {here.map((e) => {
                      const a = Math.max(e.start, start);
                      const b = Math.min(e.end, end);
                      let top = ((a - start) / HOUR_MS) * HOUR;
                      let height = Math.max(((b - a) / HOUR_MS) * HOUR, HOUR / 2);
                      if (drag?.kind === "move" && drag.entry === e)
                        top += ((drag.at - drag.grabbed) / HOUR_MS) * HOUR;
                      if (drag?.kind === "size" && drag.entry === e)
                        height = Math.max(((drag.at - e.start) / HOUR_MS) * HOUR, HOUR / 4);
                      return (
                        <Block
                          key={`${e.item.id}-${e.start}`}
                          entry={e}
                          top={top}
                          height={height}
                          drag={drag}
                          onPress={(ev, kind) => press(ev, e, kind)}
                        />
                      );
                    })}
                    {pa != null && pb != null && pa >= start && pa < end && (
                      <div
                        className="dem-cal-ghost"
                        style={{
                          top: ((pa - start) / HOUR_MS) * HOUR,
                          height: ((pb - pa) / HOUR_MS) * HOUR,
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="dem-cal-monthgrid">
            {days.map((d) => {
              const start = d.getTime();
              const end = addDays(d, 1).getTime();
              const here = entries.filter((e) => e.start < end && e.end > start);
              return (
                <button
                  key={start}
                  type="button"
                  className="dem-cal-day"
                  data-other={d.getMonth() !== monthStart.getMonth() ? "" : undefined}
                  data-today={isoDate(start) === today ? "" : undefined}
                  onClick={() => {
                    setAnchor(d);
                    setMode("week");
                  }}
                >
                  <b>{d.getDate()}</b>
                  {here.slice(0, 3).map((e) => (
                    <span key={`${e.item.id}-${e.start}`}>{titleOf(t, e.item)}</span>
                  ))}
                  {here.length > 3 && <em>{t("calendar.more", { n: here.length - 3 })}</em>}
                </button>
              );
            })}
          </div>
        )}
        <aside className="dem-cal-todos">
          <h3>{t("calendar.todos")}</h3>
          <ul>
            {todos.map((todo) => (
              <li
                key={todo.id}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                  e.preventDefault();
                  set({ kind: "todo", todo, x: e.clientX, y: e.clientY, at: null });
                }}
              >
                <span className="dem-nav-title">{titleOf(t, todo)}</span>
                <Button
                  size="sm"
                  variant="quiet"
                  icon="calendar"
                  aria-label={t("calendar.placeNext", { title: titleOf(t, todo) })}
                  onPress={() =>
                    void placeBlock(
                      titleOf(t, todo),
                      nextHour(),
                      nextHour() + HOUR_MS,
                      todo.id,
                    ).catch(failed(t, t("calendar.title")))
                  }
                />
              </li>
            ))}
          </ul>
        </aside>
      </div>
      {drag?.kind === "todo" && (
        <div className="dem-cal-carry" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {titleOf(t, drag.todo)}
        </div>
      )}
    </div>
  );
}

/** 今天的日程, on the home page. */
export function AgendaWidget({ workspace }: PanelProps) {
  const t = useT();
  const [start] = useState(() => atMidnight(Date.now()));
  const { data } = useLive<Entry[]>(
    () => loadEntries(start.getTime(), addDays(start, 1).getTime()),
    [],
  );
  if (!data.length) return <p className="dem-life-none">{t("calendar.none")}</p>;
  return (
    <ul className="dem-life-list">
      {data.map((e) => (
        <li key={`${e.item.id}-${e.start}`}>
          <button
            type="button"
            className="dem-nav-open"
            onClick={() => openItem(workspace, t, e.item, { kind: "temp" })}
          >
            <span className="dem-nav-count">{clock(e.start)}</span>
            <span className="dem-nav-title">{titleOf(t, e.item)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const toLocal = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${isoDate(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const REPEATS = ["", "FREQ=DAILY", "FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY"];

/** Start, end and repeat, in a scheduled item's details. */
export function SpanRows({
  item,
  onChange,
}: {
  item: ItemView;
  onChange: (p: ReturnType<typeof patch>) => void;
}) {
  const t = useT();
  const span = spanOf(item);
  if (!span) return null;
  const when = (key: "start" | "end", label: string) => (
    <div className="dem-fields-row">
      <dt>{label}</dt>
      <dd>
        <input
          className="dem-fields-input"
          type="datetime-local"
          aria-label={label}
          key={span[key]}
          defaultValue={toLocal(span[key])}
          onBlur={(e) => {
            const ms = new Date(e.target.value).getTime();
            if (!Number.isFinite(ms) || ms === span[key]) return;
            const next = { ...span, [key]: ms };
            if (next.end < next.start)
              next.end = key === "start" ? ms + (span.end - span.start) : next.start;
            onChange(patch({ span: next }));
          }}
        />
      </dd>
    </div>
  );
  const known = REPEATS.includes(span.recurrence ?? "");
  return (
    <>
      {when("start", t("calendar.start"))}
      {when("end", t("calendar.end"))}
      <div className="dem-fields-row">
        <dt>{t("calendar.repeat")}</dt>
        <dd>
          <select
            className="dem-fields-input"
            aria-label={t("calendar.repeat")}
            value={span.recurrence ?? ""}
            onChange={(e) =>
              onChange(patch({ span: { ...span, recurrence: e.target.value || null } }))
            }
          >
            {!known && <option value={span.recurrence ?? ""}>{span.recurrence}</option>}
            {REPEATS.map((r) => (
              <option key={r} value={r}>
                {t(`calendar.repeat.${r.replace("FREQ=", "").toLowerCase() || "none"}`)}
              </option>
            ))}
          </select>
        </dd>
      </div>
    </>
  );
}
