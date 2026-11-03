import type { CSSProperties, ReactNode } from "react";
import {
  Button as AriaButton,
  Collection,
  Tree as AriaTree,
  TreeItem,
  TreeItemContent,
  type Key,
  type TreeProps as AriaTreeProps,
} from "react-aria-components";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./list.css";

export interface TreeNode {
  id: Key;
  label: string;
  icon?: IconName;
  /** Marks or a count at the end of the row. */
  trailing?: ReactNode;
  children?: TreeNode[];
}

/** The 目录 tree and others: arrow keys move, Right expands, Left collapses. */
export function Tree({
  items,
  ...rest
}: Omit<AriaTreeProps<TreeNode>, "className" | "style" | "children" | "items"> & {
  items: TreeNode[];
  "aria-label": string;
}) {
  return (
    <AriaTree {...rest} items={items} className="dem-tree">
      {function renderNode(node: TreeNode) {
        return (
          <TreeItem id={node.id} textValue={node.label} className="dem-tree-row-host">
            <TreeItemContent>
              {({ hasChildItems, isExpanded, level, isSelected, isFocusVisible, isHovered }) => (
                <div
                  className="dem-tree-row"
                  style={{ "--level": level } as CSSProperties}
                  data-selected={isSelected || undefined}
                  data-focus-visible={isFocusVisible || undefined}
                  data-hovered={isHovered || undefined}
                >
                  {hasChildItems ? (
                    <AriaButton
                      slot="chevron"
                      className="dem-tree-chevron"
                      data-expanded={isExpanded || undefined}
                    >
                      <Icon name="chevron-right" size={14} />
                    </AriaButton>
                  ) : (
                    <span className="dem-tree-spacer" />
                  )}
                  {node.icon && <Icon name={node.icon} size={16} className="dem-list-icon" />}
                  <span className="dem-list-title">{node.label}</span>
                  {node.trailing && <span className="dem-list-meta">{node.trailing}</span>}
                </div>
              )}
            </TreeItemContent>
            {node.children && <Collection items={node.children}>{renderNode}</Collection>}
          </TreeItem>
        );
      }}
    </AriaTree>
  );
}
