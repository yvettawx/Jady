// What sits beside the text: its outline and what links to it, always for the note in front.
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { EmptyState } from "../../ui/States";
import { OpenList } from "../../workspace/OpenList";
import type { PanelProps } from "../../workspace/registry";
import { openItem } from "../actions";
import { useActiveNote } from "../active";
import { api } from "../api";
import { useLive } from "../live";
import { titleOf } from "../model";

export function OutlinePanel() {
  const t = useT();
  const note = useActiveNote();
  if (!note) return null;
  if (!note.headings.length) return <EmptyState icon="outline" title={t("outline.none")} />;
  return (
    <ul className="dem-outline">
      {note.headings.map((h) => (
        <li key={h.pos} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
          <button type="button" onClick={() => note.goTo?.(h.pos)}>
            {h.text || t("item.untitled")}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function LinksPanel({ workspace }: PanelProps) {
  const t = useT();
  const note = useActiveNote();
  const id = note?.id;
  const { data: links } = useLive<ItemView[]>(
    () => (id ? api.backlinks(id) : Promise.resolve([])),
    [],
    [id],
  );
  if (!note) return null;
  if (!links.length) return <EmptyState icon="link" title={t("links.none")} />;
  return (
    <ul className="dem-nav-list">
      {links.map((i) => (
        <li key={i.id} className="dem-nav-row">
          <button type="button" className="dem-nav-open" onClick={() => openItem(workspace, t, i)}>
            <span className="dem-nav-title">{titleOf(t, i)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function OpenPanel({ workspace }: PanelProps) {
  return <OpenList workspace={workspace} />;
}
