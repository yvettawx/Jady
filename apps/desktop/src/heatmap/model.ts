// The heat map's data (PRD B1, docs/03-modules.md activity_daily): one row per day with counts by
// type. Types are open-ended: commits and habit check-ins join in P4 as new ids, nothing else
// changes. Dates are local "yyyy-mm-dd" strings.
import { listedOutsideDirectory } from "../privacy/policy";
import type { PrivacyLevel } from "../ui/Badge";

export interface HeatDay {
  date: string;
  counts: Record<string, number>;
}

/** Something changed that day, for the day card. */
export interface HeatItem {
  id: string;
  title: string;
  type: string;
  privacy: PrivacyLevel;
}

export interface HeatData {
  /** Every day of the range in order, empty ones included. The last is today. */
  days: HeatDay[];
  /** Type ids in drawing order. */
  types: string[];
}

export const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseDate = (s: string) => {
  const [y = 1970, m = 1, d = 1] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** What the day adds up to, with hidden types left out. */
export function dayTotal(day: HeatDay, hidden: ReadonlySet<string> = new Set()): number {
  let n = 0;
  for (const [type, count] of Object.entries(day.counts)) if (!hidden.has(type)) n += count;
  return n;
}

/** Each shown type's share of the day, in drawing order. */
export function dayShares(
  day: HeatDay,
  types: readonly string[],
  hidden: ReadonlySet<string> = new Set(),
): { type: string; share: number }[] {
  const total = dayTotal(day, hidden);
  if (!total) return [];
  return types
    .filter((t) => !hidden.has(t) && (day.counts[t] ?? 0) > 0)
    .map((type) => ({ type, share: (day.counts[type] ?? 0) / total }));
}

/**
 * Maps a day's total to 0–1. The 95th percentile counts as full, so one wild day does not flatten
 * the rest; the square root keeps quiet days visible.
 */
export function intensityScale(
  days: readonly HeatDay[],
  hidden: ReadonlySet<string> = new Set(),
): (day: HeatDay) => number {
  const totals = days
    .map((d) => dayTotal(d, hidden))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const top = totals[Math.floor(totals.length * 0.95)] ?? 1;
  return (day) => Math.min(1, Math.sqrt(dayTotal(day, hidden) / top));
}

/** Days in a row with activity, counting back from today. An empty today does not break it yet. */
export function currentStreak(days: readonly HeatDay[]): number {
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (!day) break;
    if (dayTotal(day) > 0) n++;
    else if (i !== days.length - 1) break;
  }
  return n;
}

/** Column (week) and row (weekday, Monday first) of each day, for the wall and the city. */
export function weekGrid(days: readonly HeatDay[]): { col: number; row: number }[] {
  const first = days[0];
  const lead = first ? (parseDate(first.date).getDay() + 6) % 7 : 0;
  return days.map((_, i) => ({ col: Math.floor((i + lead) / 7), row: (i + lead) % 7 }));
}

/** What the day card may list: 机密 titles appear only in 目录 (2026-11-02). */
export const listedItems = (items: readonly HeatItem[]) =>
  items.filter((i) => listedOutsideDirectory(i.privacy));
