import type { ReactNode } from "react";
import { GridList, GridListItem, type GridListProps, type Key } from "react-aria-components";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./list.css";

/** A list of rows (search results, a folder's contents). Rows may hold buttons and marks. */
export function List<T extends { id: Key }>({
  ...rest
}: Omit<GridListProps<T>, "className" | "style"> & { "aria-label": string }) {
  return <GridList {...rest} className="dem-list" />;
}

export function ListItem({
  id,
  textValue,
  icon,
  title,
  description,
  meta,
  trailing,
}: {
  id: Key;
  /** What type-ahead and screen readers use; usually the title. */
  textValue: string;
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  /** Quiet text on the right, such as a date. */
  meta?: ReactNode;
  /** Marks or buttons at the end of the row. */
  trailing?: ReactNode;
}) {
  return (
    <GridListItem id={id} textValue={textValue} className="dem-list-row">
      {icon && <Icon name={icon} size={16} className="dem-list-icon" />}
      <span className="dem-list-text">
        <span className="dem-list-title">{title}</span>
        {description && <span className="dem-list-desc">{description}</span>}
      </span>
      {meta && <span className="dem-list-meta">{meta}</span>}
      {trailing}
    </GridListItem>
  );
}
