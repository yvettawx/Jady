// What AI can find: type some words, pick a kind of chat, and see what the search tool would hand
// AI, beside what your own search finds that it would not. Nothing here reaches AI.
import { useState } from "react";
import type { AiSearchPreview, SearchHit } from "../../bindings";
import { useT } from "../../i18n/context";
import { Segmented } from "../../ui/Segmented";
import { EmptyState } from "../../ui/States";
import { TextField } from "../../ui/TextField";
import type { PanelProps } from "../../workspace/registry";
import { openItem } from "../actions";
import { api } from "../api";
import { useLive } from "../live";
import { titleOf } from "../model";

export const AI_SEE_PANEL = "ai-see";

const KINDS = ["plain", "authorized", "webAuthorized"] as const;
const NONE: AiSearchPreview = { shown: [], hidden: [] };

/** The core wraps what matched in ⁅ and ⁆. */
function Snippet({ text }: { text: string }) {
  return (
    <span className="dem-nav-snippet">
      {text
        .split(/(⁅[^⁆]*⁆)/)
        .map((p, i) => (p.startsWith("⁅") ? <mark key={i}>{p.slice(1, -1)}</mark> : p))}
    </span>
  );
}

export function AiSearchPreviewPanel({ workspace }: PanelProps) {
  const t = useT();
  const [kind, setKind] = useState<(typeof KINDS)[number]>("plain");
  const [query, setQuery] = useState("");
  const q = query.trim();
  const { data } = useLive<AiSearchPreview>(() => api.aiSearchPreview(kind, q), NONE, [kind, q]);
  const hit = (h: SearchHit, mark?: string) => (
    <li key={h.item.id} className="dem-aisee-hit">
      <button
        type="button"
        className="dem-nav-open"
        onClick={() => openItem(workspace, t, h.item, { kind: "preview" })}
      >
        <span className="dem-nav-title">{titleOf(t, h.item)}</span>
        {mark && <span className="dem-nav-count">{mark}</span>}
      </button>
      {h.snippet && <Snippet text={h.snippet} />}
    </li>
  );
  return (
    <div className="dem-aisee">
      <div className="dem-aisee-tools">
        <Segmented
          aria-label={t("aiSee.kind")}
          value={kind}
          onChange={(k) => setKind(k as (typeof KINDS)[number])}
          options={KINDS.map((id) => ({ id, label: t(`aiSee.kind.${id}`) }))}
        />
        <TextField
          aria-label={t("aiSee.query")}
          placeholder={t("aiSee.query")}
          icon="search"
          value={query}
          onChange={setQuery}
        />
      </div>
      {!q && <p className="dem-life-none">{t("aiSee.recent")}</p>}
      <h3 className="dem-nav-group">{t("aiSee.shown")}</h3>
      {data.shown.length ? (
        <ul className="dem-aisee-list">{data.shown.map((h) => hit(h))}</ul>
      ) : (
        <EmptyState icon="search" title={t("aiSee.noneShown")} />
      )}
      {data.hidden.length > 0 && (
        <>
          <h3 className="dem-nav-group">{t("aiSee.hidden")}</h3>
          <ul className="dem-aisee-list dem-aisee-hidden">
            {data.hidden.map((h) => hit(h.hit, t(`aiSee.why.${h.reason}`)))}
          </ul>
        </>
      )}
    </div>
  );
}
