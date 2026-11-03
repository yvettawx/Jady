// Sums for any type with a date and a number. Works on what the type says about itself, so a
// type made by hand gets it too.
import type { TypeDef } from "../../bindings";
import { parseFields } from "../api";

export interface StatsShape {
  date: string;
  number: string;
  /** Fields it can be split by. */
  groups: { key: string; name: string; labels: Map<string, string> }[];
}

export function statsShape(def: TypeDef, name: (raw: string) => string): StatsShape | null {
  const date = def.fields.find((f) => f.kind.type === "date");
  const number = def.fields.find((f) => f.kind.type === "number" || f.kind.type === "rating");
  if (!date || !number) return null;
  return {
    date: date.key,
    number: number.key,
    groups: def.fields.flatMap((f) =>
      f.kind.type === "select"
        ? [
            {
              key: f.key,
              name: name(f.name),
              labels: new Map(f.kind.options.map((o) => [o.id, name(o.name)])),
            },
          ]
        : [],
    ),
  };
}

export interface MonthRow {
  month: string;
  total: number;
  /** By the value of the field it was split by. */
  parts: Map<string, number>;
}

/** Newest month first. Items without a date or a number are left out. */
export function monthlySums(
  items: { fields: string }[],
  shape: Pick<StatsShape, "date" | "number">,
  split: string | null,
  only?: { key: string; value: string },
): MonthRow[] {
  const rows = new Map<string, MonthRow>();
  for (const i of items) {
    const f = parseFields(i.fields);
    if (only && f[only.key] !== only.value) continue;
    const when = f[shape.date];
    const n = Number(f[shape.number]);
    if (typeof when !== "string" || when.length < 7 || !Number.isFinite(n)) continue;
    const month = when.slice(0, 7);
    const row = rows.get(month) ?? { month, total: 0, parts: new Map() };
    row.total += n;
    if (split) {
      const key = String(f[split] ?? "");
      row.parts.set(key, (row.parts.get(key) ?? 0) + n);
    }
    rows.set(month, row);
  }
  return [...rows.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** Days in a row up to today, or up to yesterday while today is still open. */
export function streakOf(days: Iterable<string>, today: string): number {
  const set = new Set(days);
  const back = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() - 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  let at = set.has(today) ? today : back(today);
  let n = 0;
  while (set.has(at)) {
    n++;
    at = back(at);
  }
  return n;
}
