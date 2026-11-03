import type { ReactNode } from "react";
import {
  Cell,
  Checkbox,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  TableLayout,
  Virtualizer,
  type Key,
  type Selection,
  type SortDescriptor,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import "./table.css";

export interface TableColumn<T> {
  id: string;
  label: string;
  /** The column that names each row for screen readers; exactly one should have it. */
  isRowHeader?: boolean;
  /** Numbers and dates line up on the right with even digit widths. */
  numeric?: boolean;
  allowsSorting?: boolean;
  width?: number;
  render?: (row: T) => ReactNode;
}

/** The selection box in the header and in each row (Space toggles it from the keyboard). */
function SelectBox({ label }: { label?: string }) {
  return (
    <Checkbox slot="selection" className="dem-check" aria-label={label}>
      {({ isIndeterminate }) => (
        <span className="dem-check-box" aria-hidden>
          <Icon name={isIndeterminate ? "rule" : "check"} size={12} />
        </span>
      )}
    </Checkbox>
  );
}

export function DataTable<T extends { id: Key }>({
  columns,
  rows,
  "aria-label": ariaLabel,
  sortDescriptor,
  onSortChange,
  onRowAction,
  empty,
  selectedKeys,
  onSelectionChange,
  virtualized,
  rowHeight = 36,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  "aria-label": string;
  sortDescriptor?: SortDescriptor;
  onSortChange?: (d: SortDescriptor) => void;
  onRowAction?: (id: Key) => void;
  /** Shown when there are no rows, usually an EmptyState. */
  empty?: ReactNode;
  /** Given: rows can be selected with a box in front (multiple selection). */
  selectedKeys?: Selection;
  onSelectionChange?: (keys: Selection) => void;
  /** Draws only the visible rows; the table then scrolls itself and needs a height. */
  virtualized?: boolean;
  /** px; only used when virtualized. */
  rowHeight?: number;
}) {
  const t = useT();
  const selectable = selectedKeys !== undefined;
  const table = (
    <Table
      aria-label={ariaLabel}
      className="dem-table"
      data-virtualized={virtualized || undefined}
      sortDescriptor={sortDescriptor}
      onSortChange={onSortChange}
      onRowAction={onRowAction && ((id) => onRowAction(id))}
      selectionMode={selectable ? "multiple" : undefined}
      selectionBehavior="toggle"
      selectedKeys={selectedKeys}
      onSelectionChange={onSelectionChange}
    >
      <TableHeader className="dem-table-head">
        {selectable && (
          <Column width={36} className="dem-table-col dem-table-select">
            <SelectBox label={t("table.selectAll")} />
          </Column>
        )}
        {columns.map((c) => (
          <Column
            key={c.id}
            id={c.id}
            isRowHeader={c.isRowHeader}
            allowsSorting={c.allowsSorting}
            width={c.width}
            className="dem-table-col"
            data-numeric={c.numeric || undefined}
          >
            {({ sortDirection }) => (
              <span className="dem-table-col-label">
                {c.label}
                {sortDirection && (
                  <Icon
                    name={sortDirection === "ascending" ? "chevron-up" : "chevron-down"}
                    size={12}
                  />
                )}
              </span>
            )}
          </Column>
        ))}
      </TableHeader>
      <TableBody items={rows} renderEmptyState={empty ? () => empty : undefined}>
        {(row) => (
          <Row id={row.id} className="dem-table-row">
            {selectable && (
              <Cell className="dem-table-cell dem-table-select">
                <SelectBox />
              </Cell>
            )}
            {columns.map((c) => (
              <Cell key={c.id} className="dem-table-cell" data-numeric={c.numeric || undefined}>
                {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.id] ?? "")}
              </Cell>
            ))}
          </Row>
        )}
      </TableBody>
    </Table>
  );
  return virtualized ? (
    <Virtualizer layout={TableLayout} layoutOptions={{ rowHeight, headingHeight: rowHeight }}>
      {table}
    </Virtualizer>
  ) : (
    table
  );
}
