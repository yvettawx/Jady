// The heat map (PRD B1, docs/05-design.md §8.1): a 年历墙 with a legend that filters by type, the
// pointer or the arrow keys pick a day, and the day card lists what changed then. As a small
// widget, picking a day opens the big one instead. The numbers count everything; 机密 titles never
// show (listedItems).
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, Popover, useLocale } from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "../ui/Icon";
import { useElementSize } from "./look";
import {
  currentStreak,
  dayTotal,
  listedItems,
  parseDate,
  type HeatData,
  type HeatItem,
} from "./model";
import "./view";
import { YearWall } from "./YearWall";
import "./heatmap.css";

/** Narrower or lower than this, it is a small widget: labels go, the shape stays. */
const COMPACT_W = 420;
const COMPACT_H = 230;

export function HeatMap({
  data,
  itemsOf,
  onOpen,
  onExpand,
  initialDay = null,
}: {
  data: HeatData;
  itemsOf: (date: string) => readonly HeatItem[];
  onOpen: (item: HeatItem) => void;
  /** As a small widget, picking a day opens the big heat map on that day. */
  onExpand?: (date: string) => void;
  /** The day to start on, as "yyyy-mm-dd". */
  initialDay?: string | null;
}) {
  const t = useT();
  const { locale } = useLocale();
  const root = useRef<HTMLDivElement>(null);
  const { w, h } = useElementSize(root);
  const compact = w < COMPACT_W || h < COMPACT_H;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [keyDay, setKeyDay] = useState<number | null>(() => {
    const at = data.days.findIndex((d) => d.date === initialDay);
    return at >= 0 ? at : null;
  });
  const [card, setCard] = useState<{ index: number; x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const locator = useRef<(i: number) => { x: number; y: number } | null>(() => null);
  const last = data.days.length - 1;

  const dateText = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    return (date: string) => fmt.format(parseDate(date));
  }, [locale]);
  const onHover = useCallback((index: number | null, x: number, y: number) => {
    setHover((v) => {
      if (index === null) return null;
      return v?.index === index && Math.abs(v.x - x) + Math.abs(v.y - y) < 2 ? v : { index, x, y };
    });
  }, []);
  const onPick = useCallback(
    (index: number, x: number, y: number) => {
      setHover(null);
      const day = data.days[index];
      if (compact && onExpand && day) onExpand(day.date);
      else setCard({ index, x, y });
    },
    [compact, onExpand, data.days],
  );
  const locate = useCallback((fn: (i: number) => { x: number; y: number } | null) => {
    locator.current = fn;
    if (import.meta.env.DEV) window.__heatLocate = fn;
  }, []);

  const cursor = hover?.index ?? keyDay;
  const streak = useMemo(() => currentStreak(data.days), [data.days]);
  const yearTotal = useMemo(
    () => data.days.reduce((n, d) => n + dayTotal(d, hidden), 0),
    [data.days, hidden],
  );

  // Keyboard: same keys for every view. Up and down move a week, as the wall's columns do.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) {
      e.preventDefault();
      setHover(null);
      setKeyDay((d) => Math.max(0, Math.min(last, (d ?? last) + (d === null ? 0 : step))));
    } else if (e.key === "Enter" && keyDay !== null) {
      const p = locator.current(keyDay);
      if (p) onPick(keyDay, p.x, p.y);
    } else if (e.key === "Escape" && keyDay !== null) setKeyDay(null);
  };

  const cardDay = card ? data.days[card.index] : undefined;
  const cardItems = cardDay ? listedItems(itemsOf(cardDay.date)) : [];
  const hoverDay = hover ? data.days[hover.index] : undefined;

  return (
    <div
      ref={root}
      className="dem-heat"
      data-compact={compact || undefined}
      role="group"
      tabIndex={0}
      aria-label={t("heatmap.title")}
      aria-description={t("heatmap.keys")}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyDay(null)}
    >
      <YearWall
        data={data}
        hidden={hidden}
        cursor={cursor}
        compact={compact}
        onHover={onHover}
        onPick={onPick}
        locate={locate}
      />

      <div className="dem-heat-foot">
        <span className="dem-heat-streak">{t("heatmap.streak", { n: streak })}</span>
        {!compact && (
          <>
            <span className="dem-heat-total">{t("heatmap.total", { n: yearTotal })}</span>
            <div className="dem-heat-legend" role="group" aria-label={t("heatmap.filter")}>
              {data.types.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="dem-heat-chip"
                  aria-pressed={!hidden.has(type)}
                  onClick={() =>
                    setHidden((s) => {
                      const next = new Set(s);
                      if (!next.delete(type)) next.add(type);
                      return next;
                    })
                  }
                >
                  <i style={{ background: `var(--dem-content-${type})` }} />
                  {t(`heatmap.type.${type}`)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="dem-heat-live" aria-live="polite">
        {keyDay !== null &&
          data.days[keyDay] &&
          t("heatmap.describe", {
            date: dateText(data.days[keyDay].date),
            n: dayTotal(data.days[keyDay], hidden),
          })}
      </p>

      {hover &&
        hoverDay &&
        !card &&
        createPortal(
          <div
            className="dem-heat-tip"
            style={{
              left: Math.min(hover.x + 12, innerWidth - 200),
              top: Math.max(8, hover.y - 62),
            }}
          >
            <div className="dem-heat-tip-date">{dateText(hoverDay.date)}</div>
            <TypeCounts counts={hoverDay.counts} types={data.types} hidden={hidden} max={3} />
          </div>,
          document.body,
        )}

      <span
        ref={anchor}
        className="dem-heat-anchor"
        style={{ left: card?.x ?? 0, top: card?.y ?? 0 }}
      />
      <Popover
        className="dem-popover dem-heat-card"
        triggerRef={anchor}
        isOpen={card !== null}
        onOpenChange={(open) => !open && setCard(null)}
        placement="bottom start"
        offset={6}
      >
        <Dialog aria-label={cardDay ? dateText(cardDay.date) : t("heatmap.title")}>
          {cardDay && (
            <>
              <h3>{dateText(cardDay.date)}</h3>
              {dayTotal(cardDay) === 0 ? (
                <p className="dem-heat-none">{t("heatmap.day.none")}</p>
              ) : (
                <TypeCounts counts={cardDay.counts} types={data.types} hidden={new Set()} />
              )}
              {cardItems.length > 0 && (
                <>
                  <h4>{t("heatmap.day.items")}</h4>
                  <ul>
                    {cardItems.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setCard(null);
                            onOpen(item);
                          }}
                        >
                          <i style={{ background: `var(--dem-content-${item.type})` }} />
                          <span>{item.title}</span>
                          {item.privacy !== "normal" && <Icon name="lock" size={12} />}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </Dialog>
      </Popover>
    </div>
  );
}

function TypeCounts({
  counts,
  types,
  hidden,
  max,
}: {
  counts: Record<string, number>;
  types: readonly string[];
  hidden: ReadonlySet<string>;
  max?: number;
}) {
  const t = useT();
  const rows = types
    .filter((type) => !hidden.has(type) && (counts[type] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    .slice(0, max);
  if (!rows.length) return <div className="dem-heat-none">{t("heatmap.day.none")}</div>;
  return (
    <ul className="dem-heat-counts">
      {rows.map((type) => (
        <li key={type}>
          <i style={{ background: `var(--dem-content-${type})` }} />
          <span>{t(`heatmap.type.${type}`)}</span>
          <b>{t("heatmap.count", { n: counts[type] ?? 0 })}</b>
        </li>
      ))}
    </ul>
  );
}
