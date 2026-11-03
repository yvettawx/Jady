// What the table and board views show (PRD A12, B5): items of one type, described by fields.
// Types and view settings are data, so custom types (P1) and templates reuse these views.
// The core's structured query (docs/03-modules.md) will replace the in-memory filtering here.
import type { BadgeTone } from "../ui/Badge";
import type { SourceKind } from "../ui/Badge";

export interface SelectOption {
  id: string;
  label: string;
  tone: BadgeTone;
}

export type FieldDef =
  | { id: string; label: string; kind: "text" | "longtext" | "date" | "tags" }
  | { id: string; label: string; kind: "select"; options: SelectOption[] }
  | { id: string; label: string; kind: "source" };

export interface TypeDef {
  id: string;
  name: string;
  /** The field that names an item. */
  titleField: string;
  fields: FieldDef[];
}

export type FieldValue = string | string[] | SourceKind | null;

export interface Item {
  id: string;
  values: Record<string, FieldValue>;
}

export interface TableSettings {
  columns: string[];
}

export interface BoardSettings {
  /** A select field; one column per option. */
  groupBy: string;
  /** Shown on each card under the title. */
  cardFields: string[];
}

export interface Sort {
  field: string;
  direction: "ascending" | "descending";
}

export interface Filter {
  text: string;
  /** Field id → allowed option ids; an empty or missing list allows everything. */
  options: Record<string, string[]>;
}

export const field = (t: TypeDef, id: string) => t.fields.find((f) => f.id === id);

const asText = (v: FieldValue | undefined): string =>
  v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v);

/** Items matching the filter: the text anywhere in the item, and each option filter. */
export function applyFilter(items: Item[], f: Filter): Item[] {
  const q = f.text.trim().toLocaleLowerCase();
  return items.filter((it) => {
    for (const [fid, allowed] of Object.entries(f.options))
      if (allowed.length && !allowed.includes(asText(it.values[fid]))) return false;
    if (!q) return true;
    return Object.values(it.values).some((v) => asText(v).toLocaleLowerCase().includes(q));
  });
}

/**
 * Sorted by one field. Select fields sort by option order (想投 before 已投), dates by date,
 * text by the locale's collation (拼音 for Chinese); empty values always go last.
 */
export function applySort(items: Item[], t: TypeDef, s: Sort | null, locale = "zh-CN"): Item[] {
  if (!s) return items;
  const f = field(t, s.field);
  if (!f) return items;
  const collator = new Intl.Collator(locale, { numeric: true });
  const key = (it: Item): number | string | null => {
    const v = it.values[f.id];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
    if (f.kind === "select") return f.options.findIndex((o) => o.id === v);
    return asText(v);
  };
  const dir = s.direction === "ascending" ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = key(a),
      y = key(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const c =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : collator.compare(String(x), String(y));
    return c * dir;
  });
}

/** Moves an item to another option of a select field, placed before `before` (or at the end). */
export function moveTo(
  items: Item[],
  id: string,
  fieldId: string,
  option: string,
  before?: string | null,
): Item[] {
  const it = items.find((x) => x.id === id);
  if (!it) return items;
  const moved = { ...it, values: { ...it.values, [fieldId]: option } };
  const rest = items.filter((x) => x.id !== id);
  const at = before ? rest.findIndex((x) => x.id === before) : -1;
  if (at < 0) return [...rest, moved];
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

const DAY = 86_400_000;

/** Days from today to an ISO date (negative when past), counted in local days. */
export function daysUntil(iso: string, now = new Date()): number {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / DAY);
}
