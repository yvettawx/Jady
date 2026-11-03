// A type's items as a table and a board (PRD A12, B5): the views only know their own model, so
// here each change they report becomes an edit in the core.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ItemView, TypeDef } from "../../bindings";
import { useT } from "../../i18n/context";
import { EmptyState } from "../../ui/States";
import type { FieldValue, Item } from "../../views/model";
import { RecordsView } from "../../views/RecordsView";
import type { PanelProps } from "../../workspace/registry";
import { failed, newItem, openById } from "../actions";
import { api, itemsChanged } from "../api";
import { useLive } from "../live";
import {
  fieldValue,
  patch,
  SOURCE_FIELD,
  TAGS_FIELD,
  TITLE_FIELD,
  titleOf,
  typeName,
  viewItem,
  viewType,
} from "../model";
import { library, useLibrary } from "../store";

const MAX_COLUMNS = 7;

function Records({ def, workspace }: { def: TypeDef; workspace: PanelProps["workspace"] }) {
  const t = useT();
  const untitled = t("item.untitled");
  const { data: core } = useLive<ItemView[]>(
    () =>
      api.itemList({
        typeId: def.id,
        states: ["inbox", "active"],
        container: null,
        tag: null,
        order: "updated",
        limit: null,
      }),
    [],
    [def.id],
  );
  const type = useMemo(() => viewType(t, def), [t, def]);
  // The order cards were dragged into: this device's, kept in the settings.
  const orderKey = `ui-order-${def.id}`;
  const { data: order } = useLive<string[]>(
    async () => JSON.parse((await api.localGet(orderKey)) ?? "[]") as string[],
    [],
    [orderKey],
  );
  const fromCore = useMemo(() => {
    const rank = new Map(order.map((id, i) => [id, i]));
    return core
      .map((i) => viewItem(def, i, untitled))
      .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }, [core, def, untitled, order]);
  // The views change their list at once; the core catches up a moment later.
  const [items, setItems] = useState<Item[]>(fromCore);
  const [seen, setSeen] = useState(fromCore);
  // Rows just added wait here until the core has given them their real id.
  const pending = useRef(new Map<string, Promise<string>>());
  const realIds = useRef(new Map<string, string>());
  const seq = useRef(0);
  if (seen !== fromCore) {
    setSeen(fromCore);
    setItems(fromCore);
  }
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });

  const onItems = (next: Item[]) => {
    const before = new Map(latest.current.map((x) => [x.id, x]));
    setItems(next);
    void api.localSet(orderKey, JSON.stringify(next.map((x) => x.id)));
    const work: Promise<unknown>[] = [];
    for (const it of next) {
      const old = before.get(it.id);
      if (!old) {
        const made = api
          .itemCreate(newItem({ typeId: def.id, fields: JSON.stringify(fieldsOf(def, it.values)) }))
          .then((v) => {
            realIds.current.set(it.id, v.id);
            return v.id;
          });
        pending.current.set(it.id, made);
        work.push(made);
        continue;
      }
      const p = diff(def, old.values, it.values);
      if (p) {
        const id = pending.current.get(it.id) ?? Promise.resolve(it.id);
        work.push(id.then((real) => api.itemUpdate(real, p)));
      }
    }
    const kept = new Set(next.map((x) => x.id));
    for (const id of before.keys())
      if (!kept.has(id)) work.push(api.itemUpdate(id, patch({ state: "trashed" })));
    void Promise.all(work)
      .then(() => itemsChanged())
      .catch(failed(t, typeName(t, def)));
  };

  const select = def.fields.find((f) => f.kind.type === "select");
  const columns = [
    TITLE_FIELD,
    ...def.fields.map((f) => f.key).slice(0, MAX_COLUMNS - 2),
    TAGS_FIELD,
    SOURCE_FIELD,
  ];
  return (
    <RecordsView
      title={typeName(t, def)}
      type={type}
      table={{ columns }}
      board={{
        groupBy: select?.key ?? "",
        cardFields: def.fields
          .filter((f) => f.key !== select?.key)
          .map((f) => f.key)
          .slice(0, 2),
      }}
      items={items}
      onItems={onItems}
      hasBoard={!!select}
      initialLayout={select && def.default_view === "board" ? "board" : "table"}
      onOpenTab={(id) => openById(workspace, t, realIds.current.get(id) ?? id, { kind: "temp" })}
      resolveId={(id) => {
        const real = realIds.current.get(id);
        return real && latest.current.some((x) => x.id === real) ? real : id;
      }}
      resolve={(id) => {
        const it = library().items.find((x) => x.id === id);
        return it ? { title: titleOf(t, it), body: it.preview } : null;
      }}
      onOpenLink={(id, how) =>
        openById(
          workspace,
          t,
          id,
          how === "split" ? { split: "right", kind: "temp" } : { kind: "temp" },
        )
      }
      newItem={(values) => ({
        id: `new-${++seq.current}`,
        values: { [TITLE_FIELD]: "", [TAGS_FIELD]: [], [SOURCE_FIELD]: "mine", ...values },
      })}
    />
  );
}

function fieldsOf(def: TypeDef, values: Record<string, FieldValue>) {
  const out: Record<string, unknown> = {};
  for (const f of def.fields)
    if (values[f.key] != null) out[f.key] = fieldValue(f, values[f.key] ?? null);
  return out;
}

const same = (a: FieldValue | undefined, b: FieldValue | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diff(
  def: TypeDef,
  old: Record<string, FieldValue>,
  next: Record<string, FieldValue>,
): ReturnType<typeof patch> | null {
  const p: Parameters<typeof patch>[0] = {};
  if (!same(old[TITLE_FIELD], next[TITLE_FIELD])) {
    const title = next[TITLE_FIELD];
    p.title = typeof title === "string" && title ? title : null;
  }
  if (!same(old[TAGS_FIELD], next[TAGS_FIELD])) {
    const tags = next[TAGS_FIELD];
    p.tags = Array.isArray(tags) ? tags : [];
  }
  const changed: Record<string, unknown> = {};
  for (const f of def.fields)
    if (!same(old[f.key], next[f.key])) changed[f.key] = fieldValue(f, next[f.key] ?? null);
  if (Object.keys(changed).length) p.fields = JSON.stringify(changed);
  return Object.keys(p).length ? patch(p) : null;
}

export function RecordsPanel({ contentId, workspace }: PanelProps) {
  const t = useT();
  const { types } = useLibrary();
  const id = contentId.replace(/^records:/, "");
  const def = types.find((x) => x.id === id);
  if (!def) return <EmptyState icon="kanban" title={t("types.gone")} />;
  return <Records key={def.id} def={def} workspace={workspace} />;
}
