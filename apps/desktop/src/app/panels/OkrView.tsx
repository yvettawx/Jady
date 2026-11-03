/* eslint-disable react-refresh/only-export-components -- the progress rule lives with its view */
// OKR (PRD E5, M5): objectives and their key results. A key result is a number typed in, a count of
// finished items, or (from P3) how well a tag is remembered. Nothing has to hang off an objective.
import { useState } from "react";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import type { WorkspaceApi } from "../../workspace/api";
import { createAndOpen, failed, newItem, openItem } from "../actions";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { titleOf } from "../model";
import { useLibrary } from "../store";

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export function krProgress(
  kr: ItemView,
  items: ItemView[],
  mastery: (tag: string) => number | null = () => null,
): { current: number; target: number } {
  const f = parseFields(kr.fields);
  const target = num(f.target);
  if (f.measure === "count") {
    const type = typeof f.count_type === "string" ? f.count_type : "";
    const tag = typeof f.count_tag === "string" ? f.count_tag : "";
    const done = items.filter((i) => {
      if (type && i.typeId !== type) return false;
      if (tag && !i.tags.includes(tag)) return false;
      const status = parseFields(i.fields).status;
      return status === undefined || status === "done";
    });
    return { current: done.length, target };
  }
  if (f.measure === "mastery") {
    const tag = typeof f.count_tag === "string" ? f.count_tag : "";
    return { current: Math.round((mastery(tag) ?? 0) * 100), target: target || 100 };
  }
  return { current: num(f.current), target };
}

function Kr({ kr, workspace }: { kr: ItemView; workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const f = parseFields(kr.fields);
  const tag = typeof f.count_tag === "string" ? f.count_tag : "";
  const { data: mastery } = useLive<number | null>(
    () => (f.measure === "mastery" ? api.masteryOf(tag) : Promise.resolve(null)),
    null,
    [f.measure, tag],
  );
  const { current, target } = krProgress(kr, items, () => mastery);
  const share = target > 0 ? Math.min(1, current / target) : 0;
  return (
    <li className="dem-okr-kr">
      <button type="button" className="dem-nav-open" onClick={() => openItem(workspace, t, kr)}>
        <span className="dem-nav-title">{titleOf(t, kr)}</span>
        <span className="dem-nav-count">{`${current}/${target}`}</span>
      </button>
      <span className="dem-okr-bar" aria-hidden>
        <i style={{ width: `${share * 100}%` }} />
      </span>
    </li>
  );
}

export function OkrView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const { items } = useLibrary();
  const [adding, setAdding] = useState<Record<string, string>>({});
  const objectives = items.filter((i) => i.typeId === "objective");
  const krs = items.filter((i) => i.typeId === "key_result");
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools">
        <Button
          size="sm"
          variant="quiet"
          icon="plus"
          onPress={() =>
            void createAndOpen(workspace, t, { typeId: "objective" }).catch(failed(t, t("okr.new")))
          }
        >
          {t("okr.new")}
        </Button>
      </div>
      {!objectives.length && <EmptyState icon="todo" title={t("okr.none")} />}
      {objectives.map((o) => (
        <section key={o.id} className="dem-okr">
          <button type="button" className="dem-nav-open" onClick={() => openItem(workspace, t, o)}>
            <span className="dem-nav-title dem-okr-title">{titleOf(t, o)}</span>
          </button>
          <ul className="dem-nav-list">
            {krs
              .filter((k) => parseFields(k.fields).objective === o.id)
              .map((k) => (
                <Kr key={k.id} kr={k} workspace={workspace} />
              ))}
          </ul>
          <TextField
            aria-label={t("okr.addKr")}
            placeholder={t("okr.addKr")}
            icon="plus"
            value={adding[o.id] ?? ""}
            onChange={(v) => setAdding((a) => ({ ...a, [o.id]: v }))}
            onKeyDown={(e) => {
              const text = (adding[o.id] ?? "").trim();
              if (e.key !== "Enter" || !text || e.nativeEvent.isComposing) return;
              setAdding((a) => ({ ...a, [o.id]: "" }));
              void api
                .itemCreate(
                  newItem({
                    typeId: "key_result",
                    title: text,
                    container: o.container,
                    fields: JSON.stringify({
                      objective: o.id,
                      measure: "manual",
                      current: 0,
                      target: 100,
                    }),
                  }),
                )
                .then(() => itemsChanged())
                .catch(failed(t, t("okr.addKr")));
            }}
          />
        </section>
      ))}
    </div>
  );
}
