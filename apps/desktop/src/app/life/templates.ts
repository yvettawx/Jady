// Templates (M12): a set of ordinary types, with their names in the language in use when installed,
// and optionally something to start from. They are data: no module knows about books or trips, and
// a plugin registers its own the same way.
import type { FieldKind, TypeDef } from "../../bindings";
import type { Translate } from "../../i18n/messages";
import type { IconName } from "../../ui/icons";
import { newItem } from "../actions";
import { api, itemsChanged } from "../api";

export interface TemplateField {
  key: string;
  /** A message key. */
  name: string;
  kind: FieldKind;
}

export interface TemplateType {
  id: string;
  name: string;
  view: TypeDef["default_view"];
  privacy: TypeDef["default_privacy"];
  color?: string;
  fields: TemplateField[];
}

export interface Template {
  id: string;
  icon: IconName;
  /** Message keys. */
  name: string;
  about: string;
  types: TemplateType[];
  /** A project with these to-dos, made when asked: a trip and what to get done for it. */
  starter?: { action: string; todos: string[] };
}

const templates = new Map<string, Template>();

export function registerTemplate(template: Template): () => void {
  templates.set(template.id, template);
  return () => {
    if (templates.get(template.id) === template) templates.delete(template.id);
  };
}

export const allTemplates = () => [...templates.values()];

export const isInstalled = (template: Template, types: TypeDef[]) =>
  template.types.every((x) => types.some((d) => d.id === x.id));

/** Adds the types still missing. One that is already there, and maybe changed, stays as it is. */
export async function installTemplate(t: Translate, template: Template, types: TypeDef[]) {
  const have = new Set(types.map((d) => d.id));
  for (const x of template.types) {
    if (have.has(x.id)) continue;
    await api.typeSave({
      id: x.id,
      name: t(x.name),
      builtin: false,
      default_view: x.view,
      default_privacy: x.privacy,
      color: x.color ?? null,
      fields: x.fields.map((f) => ({
        key: f.key,
        name: t(f.name),
        required: false,
        kind:
          f.kind.type === "select"
            ? {
                type: "select",
                options: f.kind.options.map((o) => ({ ...o, name: t(o.name) })),
              }
            : f.kind,
      })),
    });
  }
}

export async function startFrom(t: Translate, template: Template, title: string) {
  const project = await api.itemCreate(newItem({ typeId: "project", title }));
  for (const todo of template.starter?.todos ?? [])
    await api.itemCreate(newItem({ typeId: "todo", title: t(todo), container: project.id }));
  itemsChanged();
  return project;
}

const text = (key: string, prefix: string): TemplateField => ({
  key,
  name: `${prefix}.${key}`,
  kind: { type: "text" },
});
const date = (key: string, prefix: string): TemplateField => ({
  key,
  name: `${prefix}.${key}`,
  kind: { type: "date" },
});
const number = (key: string, prefix: string): TemplateField => ({
  key,
  name: `${prefix}.${key}`,
  kind: { type: "number" },
});
const select = (key: string, prefix: string, ids: string[]): TemplateField => ({
  key,
  name: `${prefix}.${key}`,
  kind: {
    type: "select",
    options: ids.map((id) => ({ id, name: `${prefix}.${key}.${id}`, tone: null })),
  },
});

const CATEGORIES = ["food", "home", "transport", "fun", "health", "other"];

export const BUILT_IN_TEMPLATES: Template[] = [
  {
    id: "habit",
    icon: "check",
    name: "template.habit",
    about: "template.habit.about",
    types: [
      {
        id: "habit",
        name: "template.habit.type",
        view: "table",
        privacy: "normal",
        color: "todo",
        fields: [text("cue", "template.habit")],
      },
      {
        id: "habit_log",
        name: "template.habit.log",
        view: "table",
        privacy: "normal",
        color: "todo",
        fields: [text("habit", "template.habit"), date("date", "template.habit")],
      },
    ],
  },
  {
    id: "media",
    icon: "read",
    name: "template.media",
    about: "template.media.about",
    types: [
      {
        id: "media",
        name: "template.media.type",
        view: "board",
        privacy: "normal",
        color: "file",
        fields: [
          select("status", "template.media", ["want", "doing", "done"]),
          select("kind", "template.media", ["book", "movie", "show", "game"]),
          { key: "rating", name: "template.media.rating", kind: { type: "rating", max: 5 } },
          text("creator", "template.media"),
          text("review", "template.media"),
          date("finished", "template.media"),
        ],
      },
    ],
  },
  {
    id: "finance",
    icon: "kanban",
    name: "template.finance",
    about: "template.finance.about",
    types: [
      {
        id: "transaction",
        name: "template.finance.type",
        view: "table",
        privacy: "sensitive",
        fields: [
          number("amount", "template.finance"),
          select("category", "template.finance", CATEGORIES),
          select("direction", "template.finance", ["expense", "income"]),
          date("date", "template.finance"),
        ],
      },
      {
        id: "budget",
        name: "template.finance.budget",
        view: "table",
        privacy: "sensitive",
        fields: [
          select("category", "template.finance", CATEGORIES),
          number("amount", "template.finance"),
        ],
      },
    ],
  },
  {
    id: "trip",
    icon: "place",
    name: "template.trip",
    about: "template.trip.about",
    starter: {
      action: "template.trip.start",
      todos: ["template.trip.todo.tickets", "template.trip.todo.stay", "template.trip.todo.pack"],
    },
    types: [
      {
        id: "trip_stop",
        name: "template.trip.type",
        view: "table",
        privacy: "normal",
        color: "entity",
        fields: [
          date("date", "template.trip"),
          select("kind", "template.trip", ["go", "stay", "see", "eat"]),
          text("trip", "template.trip"),
          number("lat", "template.trip"),
          number("lng", "template.trip"),
        ],
      },
      {
        id: "booking",
        name: "template.trip.booking",
        view: "table",
        privacy: "sensitive",
        color: "entity",
        fields: [text("code", "template.trip"), date("date", "template.trip")],
      },
    ],
  },
];
BUILT_IN_TEMPLATES.forEach(registerTemplate);
