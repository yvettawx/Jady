import type { Key } from "react-aria-components";
import {
  Button,
  FieldError,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type SelectProps as AriaSelectProps,
} from "react-aria-components";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./field.css";
import "./overlay.css";
import "./select.css";

export interface SelectOption {
  id: Key;
  label: string;
  icon?: IconName;
}

export type SelectProps = Omit<
  AriaSelectProps<SelectOption>,
  "className" | "style" | "children" | "selectionMode"
> & {
  label?: string;
  description?: string;
  errorMessage?: string;
  options: SelectOption[];
};

export function Select({ label, description, errorMessage, options, ...rest }: SelectProps) {
  return (
    <AriaSelect {...rest} className="dem-field dem-select">
      {label && <Label className="dem-field-label">{label}</Label>}
      <Button className="dem-field-box dem-select-button">
        {/* Text only: the option's icon and check mark belong in the list, not the button. */}
        <SelectValue<SelectOption> className="dem-select-value">
          {({ isPlaceholder, defaultChildren, selectedText }) =>
            isPlaceholder ? defaultChildren : selectedText
          }
        </SelectValue>
        <Icon name="chevron-down" size={14} className="dem-field-icon" />
      </Button>
      {description && (
        <Text slot="description" className="dem-field-hint">
          {description}
        </Text>
      )}
      <FieldError className="dem-field-error">{errorMessage}</FieldError>
      <Popover className="dem-popover" offset={4}>
        <ListBox className="dem-listbox" items={options}>
          {(o) => (
            <ListBoxItem className="dem-option" id={o.id} textValue={o.label}>
              {o.icon && <Icon name={o.icon} size={14} />}
              <span className="dem-option-label">{o.label}</span>
              <Icon name="check" size={14} className="dem-option-check" />
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
