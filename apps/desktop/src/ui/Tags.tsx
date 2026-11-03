import { Button, Label, Tag, TagGroup, TagList, type Key } from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import "./field.css";
import "./tags.css";

export interface TagItem {
  id: Key;
  label: string;
}

/** The #标签 on a piece of content. Removable when onRemove is given (Backspace or Delete). */
export function Tags({
  items,
  label,
  "aria-label": ariaLabel,
  onRemove,
}: {
  items: TagItem[];
  label?: string;
  "aria-label"?: string;
  onRemove?: (ids: Set<Key>) => void;
}) {
  const t = useT();
  return (
    <TagGroup className="dem-tags" aria-label={ariaLabel} onRemove={onRemove}>
      {label && <Label className="dem-field-label">{label}</Label>}
      <TagList className="dem-tag-list" items={items}>
        {(tag) => (
          <Tag className="dem-tag" id={tag.id} textValue={tag.label}>
            <span className="dem-tag-hash">#</span>
            {tag.label}
            {/* React Aria adds the tag's own name to the button's label. */}
            {onRemove && (
              <Button slot="remove" className="dem-tag-remove" aria-label={t("tag.remove")}>
                <Icon name="close" size={12} />
              </Button>
            )}
          </Tag>
        )}
      </TagList>
    </TagGroup>
  );
}
