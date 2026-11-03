// 时间轴 (B3): anything that says when it happened, on one line, BCE and year-only dates included.
// One type's items when opened from that type, otherwise everything.
import { useMemo, useState } from "react";
import type { TimelineEntry } from "../../bindings";
import { useT } from "../../i18n/context";
import { Select } from "../../ui/Select";
import { EmptyState } from "../../ui/States";
import type { PanelProps } from "../../workspace/registry";
import { openItem } from "../actions";
import { api } from "../api";
import { useLive } from "../live";
import { titleOf, typeName } from "../model";
import { useLibrary } from "../store";

const eraOf = (key: number) => Math.trunc(key / 10_000);

export function TimelinePanel({ params, workspace }: PanelProps) {
  const t = useT();
  const { types } = useLibrary();
  const fixed = typeof params.typeId === "string" ? params.typeId : null;
  const [only, setOnly] = useState("");
  const { data } = useLive<TimelineEntry[]>(() => api.timeline(fixed), [], [fixed]);
  const present = useMemo(() => [...new Set(data.map((e) => e.item.typeId))], [data]);
  const shown = only ? data.filter((e) => e.item.typeId === only) : data;
  if (!data.length) return <EmptyState icon="calendar" title={t("timeline.none")} />;
  const name = (id: string) =>
    typeName(
      t,
      types.find((x) => x.id === id),
    ) || id;
  return (
    <div className="dem-timeline">
      {!fixed && present.length > 1 && (
        <header className="dem-life-head">
          <Select
            aria-label={t("timeline.filter")}
            selectedKey={only}
            onSelectionChange={(k) => setOnly(String(k))}
            options={[
              { id: "", label: t("timeline.all") },
              ...present.map((id) => ({ id, label: name(id) })),
            ]}
          />
        </header>
      )}
      <ol>
        {shown.map((e, i) => {
          const year = eraOf(e.key ?? 0);
          const first = i === 0 || eraOf(shown[i - 1]?.key ?? 0) !== year;
          return (
            <li key={e.item.id} data-first={first ? "" : undefined}>
              <time>{e.when}</time>
              <button
                type="button"
                className="dem-nav-open"
                onClick={() => openItem(workspace, t, e.item, { kind: "temp" })}
              >
                <span className="dem-nav-title">{titleOf(t, e.item)}</span>
                <span className="dem-nav-count">{name(e.item.typeId)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
