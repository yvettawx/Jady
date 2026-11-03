// A type's items as a table or a board (PRD B5), on paper, with one search and status filter
// for both, a batch bar when rows are selected, and the detail sliding in from the right.
import { useMemo, useState } from "react";
import { ToggleButton, ToggleButtonGroup, type Key, type Selection } from "react-aria-components";
import { useT } from "../i18n/context";
import type { LinkTarget, OpenHow } from "../editor/WikiLink";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { MenuButton } from "../ui/Menu";
import { Segmented } from "../ui/Segmented";
import { TextField } from "../ui/TextField";
import { BoardView } from "./BoardView";
import { DetailPanel } from "./DetailPanel";
import {
  applyFilter,
  applySort,
  field,
  moveTo,
  type BoardSettings,
  type FieldValue,
  type Filter,
  type Item,
  type Sort,
  type TableSettings,
  type TypeDef,
} from "./model";
import { TableView } from "./TableView";
import "./views.css";

export type RecordsLayout = "table" | "board";

export function RecordsView({
  title,
  type,
  table,
  board,
  items,
  onItems,
  initialLayout = "board",
  onOpenTab,
  resolve,
  onOpenLink,
  newItem,
  virtualized,
  hasBoard = true,
  resolveId,
}: {
  title: string;
  type: TypeDef;
  table: TableSettings;
  board: BoardSettings;
  items: Item[];
  onItems: (items: Item[]) => void;
  initialLayout?: RecordsLayout;
  onOpenTab: (id: string) => void;
  resolve: (target: string) => LinkTarget | null;
  onOpenLink: (target: string, how: OpenHow) => void;
  newItem: (values: Record<string, FieldValue>) => Item;
  virtualized?: boolean;
  /** Off when the type has no select field to make columns from. */
  hasBoard?: boolean;
  /** A row that was just added may get its real id a moment later. */
  resolveId?: (id: string) => string;
}) {
  const t = useT();
  const [layout, setLayout] = useState<RecordsLayout>(initialLayout);
  const [filter, setFilter] = useState<Filter>({ text: "", options: {} });
  const [sort, setSort] = useState<Sort | null>(null);
  const [selection, setSelection] = useState<Selection>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const group = field(type, board.groupBy);
  const options = group?.kind === "select" ? group.options : [];
  const shown = useMemo(
    () => applySort(applyFilter(items, filter), type, sort),
    [items, filter, sort, type],
  );
  const selectedIds = selection === "all" ? shown.map((x) => x.id) : [...selection].map(String);

  const setValue = (id: string, fid: string, v: FieldValue) =>
    onItems(items.map((x) => (x.id === id ? { ...x, values: { ...x.values, [fid]: v } } : x)));

  return (
    <section className="dem-records">
      <header className="dem-records-head">
        <h1 className="dem-records-title">{title}</h1>
        <span className="dem-records-count">{t("records.count", { n: shown.length })}</span>
        <span className="dem-records-gap" />
        {hasBoard && (
          <Segmented
            aria-label={t("records.layout")}
            options={[
              { id: "board", label: t("records.board") },
              { id: "table", label: t("records.table") },
            ]}
            value={layout}
            onChange={(id) => setLayout(id as RecordsLayout)}
          />
        )}
      </header>
      <div className="dem-records-tools">
        <TextField
          aria-label={t("records.search")}
          placeholder={t("records.search")}
          icon="search"
          value={filter.text}
          onChange={(text) => setFilter((f) => ({ ...f, text }))}
        />
        {group && (
          <ToggleButtonGroup
            aria-label={group.label}
            className="dem-records-chips"
            selectionMode="multiple"
            selectedKeys={filter.options[group.id] ?? []}
            onSelectionChange={(keys: Set<Key>) =>
              setFilter((f) => ({
                ...f,
                options: { ...f.options, [group.id]: [...keys].map(String) },
              }))
            }
          >
            {options.map((o) => (
              <ToggleButton key={o.id} id={o.id} className="dem-records-chip">
                {o.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}
      </div>

      {selectedIds.length > 0 && layout === "table" && (
        <div className="dem-records-batch" role="toolbar" aria-label={t("records.batch")}>
          <span>{t("records.selected", { n: selectedIds.length })}</span>
          {group && (
            <MenuButton
              label={t("records.setField", { field: group.label })}
              icon="edit"
              variant="secondary"
              items={options.map((o) => ({ id: o.id, label: o.label }))}
              onAction={(k) =>
                onItems(
                  items.map((x) =>
                    selectedIds.includes(x.id)
                      ? { ...x, values: { ...x.values, [group.id]: String(k) } }
                      : x,
                  ),
                )
              }
            />
          )}
          <Button variant="danger" icon="delete" onPress={() => setConfirmDelete(true)}>
            {t("records.delete")}
          </Button>
          <Button variant="quiet" onPress={() => setSelection(new Set())}>
            {t("records.clearSelection")}
          </Button>
        </div>
      )}

      <div className="dem-records-body">
        {layout === "table" ? (
          <TableView
            type={type}
            table={table}
            items={shown}
            sort={sort}
            onSort={setSort}
            selection={selection}
            onSelection={setSelection}
            onOpen={setOpen}
            virtualized={virtualized}
          />
        ) : (
          <BoardView
            type={type}
            board={board}
            items={shown}
            selected={open}
            onMove={(ids, option, before) => {
              let next = items;
              for (const id of ids) next = moveTo(next, id, board.groupBy, option, before);
              onItems(next);
            }}
            onOpen={setOpen}
            onAdd={(option) => {
              const it = newItem({ [board.groupBy]: option });
              onItems([...items, it]);
              setOpen(it.id);
            }}
          />
        )}
        <DetailPanel
          type={type}
          item={items.find((x) => x.id === (open && (resolveId?.(open) ?? open))) ?? null}
          onChange={setValue}
          onClose={() => setOpen(null)}
          onOpenTab={onOpenTab}
          resolve={resolve}
          onOpenLink={onOpenLink}
        />
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("records.deleteTitle", { n: selectedIds.length })}
        message={t("records.deleteMessage")}
        confirmLabel={t("records.delete")}
        danger
        onConfirm={() => {
          onItems(items.filter((x) => !selectedIds.includes(x.id)));
          setSelection(new Set());
        }}
      />
    </section>
  );
}
