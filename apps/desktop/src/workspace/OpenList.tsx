// 打开的内容 (docs/05-design.md §3.2): every open tab in one vertical list, pinned first.
// Entries can be dragged to reorder within their section; from then on the list keeps that
// order and new temporary tabs go to the top of the temporary section.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button as AriaButton,
  GridList,
  GridListItem,
  useDragAndDrop,
  type Key,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "../ui/Icon";
import type { TabInfo, WorkspaceApi } from "./api";
import { panelDefinition } from "./registry";
import { moveOpen, orderOpen, type OpenEntry } from "./openOrder";
import "../ui/list.css";
import "./open-list.css";

/** Lists things being worked on: not the tools around them, and not the home page. */
const isContent = (tab: TabInfo) =>
  tab.component !== "home" && panelDefinition(tab.component)?.role !== "widget";

export function OpenList({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const [tabs, setTabs] = useState<TabInfo[]>(() => workspace.tabs().filter(isContent));
  const [manual, setManual] = useState<string[] | null>(null);
  const dragged = useRef<Key | null>(null);
  // Tabs can change between the first render and subscribing (loading a space's layout mounts
  // this panel midway), so read them once more after subscribing.
  useEffect(() => {
    const sync = () => setTabs(workspace.tabs().filter(isContent));
    const off = workspace.subscribe(sync);
    sync();
    return off;
  }, [workspace]);

  const entries: OpenEntry[] = useMemo(
    () => tabs.map((x) => ({ id: x.id, pinned: x.kind === "pin", openedAt: x.openedAt })),
    [tabs],
  );
  const byId = useMemo(() => new Map(tabs.map((x) => [x.id, x])), [tabs]);
  const items = orderOpen(entries, manual).flatMap((id) => byId.get(id) ?? []);
  const pinned = (k: Key | null) => byId.get(String(k))?.kind === "pin";

  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((k) => ({ "text/plain": byId.get(String(k))?.title ?? "" })),
    onDragStart: (e) => (dragged.current = [...e.keys][0] ?? null),
    onDragEnd: () => (dragged.current = null),
    // Only offer drop spots inside the dragged entry's own section.
    getDropOperation: (target) =>
      target.type === "item" && pinned(target.key) === pinned(dragged.current) ? "move" : "cancel",
    onReorder: (e) => {
      const from = String([...e.keys][0]);
      const where = e.target.dropPosition === "after" ? "after" : "before";
      const next = moveOpen(entries, manual, from, String(e.target.key), where);
      if (next) setManual(next);
    },
  });

  return (
    <GridList
      aria-label={t("open.title")}
      items={items}
      className="dem-list dem-open-list"
      dragAndDropHooks={dragAndDropHooks}
      onAction={(id) => workspace.activate(String(id))}
    >
      {(tab) => (
        <GridListItem
          id={tab.id}
          textValue={tab.title}
          className="dem-list-row dem-open-row"
          data-kind={tab.kind}
          data-active={tab.isActive || undefined}
        >
          <AriaButton
            slot="drag"
            className="dem-open-drag"
            aria-label={t("open.drag", { title: tab.title })}
          >
            <Icon name="drag" size={12} />
          </AriaButton>
          <span className="dem-open-pin" aria-hidden>
            {tab.kind === "pin" ? "◆" : ""}
          </span>
          <span className="dem-list-title dem-open-title">{tab.title}</span>
          {typeof tab.params.privacy === "string" && tab.params.privacy !== "normal" && (
            <span className="dem-ctab-lock" data-privacy={tab.params.privacy}>
              <Icon name="lock" size={12} />
            </span>
          )}
          {tab.kind !== "pin" && (
            <AriaButton
              className="dem-open-close"
              aria-label={t("tab.close", { title: tab.title })}
              onPress={() => workspace.close(tab.id)}
            >
              <Icon name="close" size={12} />
            </AriaButton>
          )}
        </GridListItem>
      )}
    </GridList>
  );
}
