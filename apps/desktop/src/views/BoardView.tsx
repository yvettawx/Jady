// 看板 (docs/05-design.md §7, PRD B5): one column per option of a select field; dragging a card
// to another column changes that field, dragging within a column reorders. React Aria's drag
// and drop gives keyboard dragging (focus a card's handle, Enter, arrows, Enter) and screen
// reader announcements; the slide into place on drop is ours (useFlip).
import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  Button as AriaButton,
  DropIndicator,
  GridList,
  GridListItem,
  useDragAndDrop,
  type Key,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { FieldValue } from "./FieldValue";
import { field, type BoardSettings, type Item, type SelectOption, type TypeDef } from "./model";
import "./views.css";

const DRAG_TYPE = "application/x-dem-item";

/**
 * After each render, every card that moved slides from where it was (React Aria marks each
 * item with data-key).
 * Durations come from the motion tokens, which are 0 with reduced motion.
 */
function useFlip(root: RefObject<HTMLElement | null>, version: unknown) {
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const duration = parseFloat(css.getPropertyValue("--dem-dur-base")) || 0;
    const easing = css.getPropertyValue("--dem-ease-spring").trim() || "ease-out";
    const next = new Map<string, DOMRect>();
    for (const card of el.querySelectorAll<HTMLElement>(".dem-board-card[data-key]")) {
      const key = card.dataset.key ?? "";
      const now = card.getBoundingClientRect();
      next.set(key, now);
      const was = last.current.get(key);
      if (!was || !duration) continue;
      const dx = was.left - now.left,
        dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration,
        easing,
      });
    }
    last.current = next;
  }, [root, version]);
}

function Column({
  type,
  board,
  option,
  items,
  selected,
  onMove,
  onOpen,
  onAdd,
}: {
  type: TypeDef;
  board: BoardSettings;
  option: SelectOption;
  items: Item[];
  selected: string | null;
  onMove: (ids: string[], option: string, before: string | null) => void;
  onOpen: (id: string) => void;
  onAdd: (option: string) => void;
}) {
  const t = useT();
  const title = (it: Item) => String(it.values[type.titleField] ?? "");
  const idsOf = async (e: { items: { kind: string }[] }) =>
    Promise.all(
      e.items
        .filter(
          (i): i is { kind: "text"; getText: (t: string) => Promise<string> } & typeof i =>
            i.kind === "text",
        )
        .map((i) => i.getText(DRAG_TYPE)),
    );
  const after = (key: Key) => {
    const at = items.findIndex((x) => x.id === key);
    return items[at + 1]?.id ?? null;
  };
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) =>
      [...keys].map((k) => ({
        [DRAG_TYPE]: String(k),
        "text/plain": title(items.find((x) => x.id === k) ?? { id: "", values: {} }),
      })),
    acceptedDragTypes: [DRAG_TYPE],
    getDropOperation: () => "move",
    onInsert: async (e) => {
      const ids = await idsOf(e);
      const target = String(e.target.key);
      onMove(ids, option.id, e.target.dropPosition === "before" ? target : after(target));
    },
    onRootDrop: async (e) => onMove(await idsOf(e), option.id, null),
    onReorder: (e) => {
      const target = String(e.target.key);
      onMove(
        [...e.keys].map(String),
        option.id,
        e.target.dropPosition === "before" ? target : after(target),
      );
    },
    renderDropIndicator: (target) => <DropIndicator target={target} className="dem-board-drop" />,
  });
  return (
    <section className="dem-board-col" aria-labelledby={`col-${option.id}`}>
      <header className="dem-board-col-head">
        <h3 id={`col-${option.id}`}>
          <Badge tone={option.tone}>{option.label}</Badge>
        </h3>
        <span className="dem-board-count">{items.length}</span>
      </header>
      <GridList
        aria-labelledby={`col-${option.id}`}
        className="dem-board-list"
        items={items}
        dragAndDropHooks={dragAndDropHooks}
        onAction={(k) => onOpen(String(k))}
        renderEmptyState={() => <p className="dem-board-empty">{t("board.empty")}</p>}
      >
        {(it) => (
          <GridListItem
            id={it.id}
            textValue={title(it)}
            className={selected === it.id ? "dem-board-card is-open" : "dem-board-card"}
          >
            <AriaButton slot="drag" className="dem-board-handle" aria-label={t("board.drag")}>
              <Icon name="drag" size={14} />
            </AriaButton>
            <span className="dem-board-card-title">{title(it)}</span>
            <span className="dem-board-card-fields">
              {board.cardFields.map((fid) => {
                const f = field(type, fid);
                return f ? <FieldValue key={fid} field={f} value={it.values[fid]} /> : null;
              })}
            </span>
          </GridListItem>
        )}
      </GridList>
      <Button variant="quiet" size="sm" icon="plus" onPress={() => onAdd(option.id)}>
        {t("board.add")}
      </Button>
    </section>
  );
}

export function BoardView({
  type,
  board,
  items,
  selected,
  onMove,
  onOpen,
  onAdd,
}: {
  type: TypeDef;
  board: BoardSettings;
  items: Item[];
  selected: string | null;
  onMove: (ids: string[], option: string, before: string | null) => void;
  onOpen: (id: string) => void;
  onAdd: (option: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useFlip(root, items);
  const group = field(type, board.groupBy);
  if (group?.kind !== "select") return null;
  return (
    <div className="dem-board" ref={root}>
      {group.options.map((o) => (
        <Column
          key={o.id}
          type={type}
          board={board}
          option={o}
          items={items.filter((x) => x.values[group.id] === o.id)}
          selected={selected}
          onMove={onMove}
          onOpen={onOpen}
          onAdd={onAdd}
        />
      ))}
    </div>
  );
}
