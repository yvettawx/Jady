// 表格 (PRD B5): the type's fields as columns; sort by a column, select rows to change them
// together. Searching and filtering live in RecordsView, shared with the board.
import type { Key, Selection, SortDescriptor } from "react-aria-components";
import { useT } from "../i18n/context";
import { DataTable, type TableColumn } from "../ui/DataTable";
import { EmptyState } from "../ui/States";
import { FieldValue } from "./FieldValue";
import { field, type Item, type Sort, type TableSettings, type TypeDef } from "./model";

export function TableView({
  type,
  table,
  items,
  sort,
  onSort,
  selection,
  onSelection,
  onOpen,
  virtualized,
}: {
  type: TypeDef;
  table: TableSettings;
  items: Item[];
  sort: Sort | null;
  onSort: (s: Sort) => void;
  selection: Selection;
  onSelection: (s: Selection) => void;
  onOpen: (id: string) => void;
  virtualized?: boolean;
}) {
  const t = useT();
  const columns: TableColumn<Item>[] = table.columns.flatMap((fid) => {
    const f = field(type, fid);
    if (!f) return [];
    return [
      {
        id: f.id,
        label: f.label,
        isRowHeader: f.id === type.titleField,
        allowsSorting: f.kind !== "longtext",
        width: f.id === type.titleField ? 220 : undefined,
        render: (it: Item) => <FieldValue field={f} value={it.values[f.id]} />,
      },
    ];
  });
  const descriptor: SortDescriptor | undefined = sort
    ? { column: sort.field as Key, direction: sort.direction }
    : undefined;
  return (
    <div className="dem-records-table">
      <DataTable
        aria-label={type.name}
        columns={columns}
        rows={items}
        sortDescriptor={descriptor}
        onSortChange={(d) => onSort({ field: String(d.column), direction: d.direction })}
        onRowAction={(id) => onOpen(String(id))}
        selectedKeys={selection}
        onSelectionChange={onSelection}
        virtualized={virtualized}
        empty={<EmptyState icon="filter" title={t("records.noMatch")} />}
      />
    </div>
  );
}
