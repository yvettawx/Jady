// Turns what the core says into what the interface shows.
import type {
  FieldDef as CoreField,
  ItemPatch,
  ItemView,
  SelectOption,
  TypeDef,
} from "../bindings";
import type { Translate } from "../i18n/messages";
import type { BadgeTone, PrivacyLevel, SourceKind } from "../ui/Badge";
import type { IconName } from "../ui/icons";
import type { FieldDef, FieldValue, Item, TypeDef as ViewType } from "../views/model";
import { parseFields } from "./api";

/** The core calls the top level `confidential`; the interface says `secret`. */
export const levelOf = (privacy: string): PrivacyLevel =>
  privacy === "confidential"
    ? "secret"
    : privacy === "sensitive" || privacy === "private"
      ? privacy
      : "normal";

export const coreLevel = (level: PrivacyLevel) => (level === "secret" ? "confidential" : level);

/** Only the keys given change. A key with `null` clears that value. */
export const patch = (p: Partial<ItemPatch>) => p as ItemPatch;

const TYPE_ICONS: Record<string, IconName> = {
  note: "file",
  idea: "star-map",
  diary: "book",
  article: "read",
  reference: "link",
  file: "attachment",
  todo: "todo",
  card: "card",
  domain: "folder",
  project: "kanban",
  person: "person",
  place: "place",
  event: "calendar",
  organization: "job",
};

export const iconOf = (typeId: string): IconName => TYPE_ICONS[typeId] ?? "file";

/** Built-in types carry a message key as their name; custom ones what the user typed. */
export const typeName = (t: Translate, def: TypeDef | undefined) =>
  def ? (def.builtin ? t(def.name) : def.name) : "";

const fieldName = (t: Translate, def: TypeDef, f: CoreField) => (def.builtin ? t(f.name) : f.name);
const optionName = (t: Translate, def: TypeDef, o: SelectOption) =>
  def.builtin ? t(o.name) : o.name;

/** What a title shows: 机密 items never show theirs outside 目录. */
export function titleOf(t: Translate, item: ItemView, directory = false): string {
  if (item.privacy === "confidential" && !directory) return t("privacy.secretTitle");
  return item.title || t("item.untitled");
}

/** Local "yyyy-mm-dd" for a time in milliseconds. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Noon that day, so a date stays the same day in every time zone nearby. */
export function dateToMs(iso: string): number {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const TONES: BadgeTone[] = ["neutral", "accent", "ai", "ok", "warn", "danger"];
const toneOf = (tone: string | null | undefined): BadgeTone =>
  TONES.find((x) => x === tone) ?? "neutral";

function viewField(t: Translate, def: TypeDef, f: CoreField): FieldDef {
  const label = fieldName(t, def, f);
  switch (f.kind.type) {
    case "select":
      return {
        id: f.key,
        label,
        kind: "select",
        options: f.kind.options.map((o) => ({
          id: o.id,
          label: optionName(t, def, o),
          tone: toneOf(o.tone),
        })),
      };
    case "multi_select":
      return { id: f.key, label, kind: "tags" };
    case "date":
      return { id: f.key, label, kind: "date" };
    default:
      return { id: f.key, label, kind: "text" };
  }
}

export const TITLE_FIELD = "title";
export const TAGS_FIELD = "tags";
export const SOURCE_FIELD = "source";

/** A type as the table and board see it: the title, its own fields, then tags and the source. */
export function viewType(t: Translate, def: TypeDef): ViewType {
  return {
    id: def.id,
    name: typeName(t, def),
    titleField: TITLE_FIELD,
    fields: [
      { id: TITLE_FIELD, label: t("item.title"), kind: "text" },
      ...def.fields.map((f) => viewField(t, def, f)),
      { id: TAGS_FIELD, label: t("item.tags"), kind: "tags" },
      { id: SOURCE_FIELD, label: t("item.source"), kind: "source" },
    ],
  };
}

export const sourceKind = (item: ItemView): SourceKind => {
  const s = item.source;
  if (!s) return "mine";
  if (s.conflict) return "conflict";
  if (s.needsCheck) return "unverified";
  return s.origin === "aiMemory" || s.origin === "aiSearch" || s.origin === "import"
    ? s.origin
    : "mine";
};

export function viewItem(def: TypeDef, item: ItemView, untitled: string): Item {
  const raw = parseFields(item.fields);
  const values: Record<string, FieldValue> = {
    [TITLE_FIELD]: item.title || untitled,
    [TAGS_FIELD]: item.tags,
    [SOURCE_FIELD]: sourceKind(item),
  };
  for (const f of def.fields) {
    const v = raw[f.key];
    if (v == null) values[f.key] = null;
    else if (Array.isArray(v)) values[f.key] = v.map(String);
    else if (typeof v === "boolean") values[f.key] = v ? "✓" : "";
    else if (typeof v === "string" || typeof v === "number") values[f.key] = String(v);
    else values[f.key] = null;
  }
  return { id: item.id, values };
}

/** A value edited in a view, as the core stores it for that field. */
export function fieldValue(f: CoreField, v: FieldValue): unknown {
  if (v == null || v === "") return null;
  if (f.kind.type === "number" || f.kind.type === "rating") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (f.kind.type === "checkbox") return v === "✓" || v === "true";
  return v;
}
