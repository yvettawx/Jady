import {
  FieldError,
  Input,
  Label,
  Text,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./field.css";

export type TextFieldProps = Omit<AriaTextFieldProps, "className" | "style" | "children"> & {
  /** Visible label. Without one, pass aria-label. */
  label?: string;
  description?: string;
  /** Shown when the field is invalid; React Aria's own message is used if omitted. */
  errorMessage?: string;
  placeholder?: string;
  icon?: IconName;
};

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  icon,
  ...rest
}: TextFieldProps) {
  return (
    <AriaTextField {...rest} className="dem-field">
      {label && <Label className="dem-field-label">{label}</Label>}
      <div className="dem-field-box">
        {icon && <Icon name={icon} size={14} className="dem-field-icon" />}
        <Input className="dem-field-input" placeholder={placeholder} />
      </div>
      {description && (
        <Text slot="description" className="dem-field-hint">
          {description}
        </Text>
      )}
      <FieldError className="dem-field-error">{errorMessage}</FieldError>
    </AriaTextField>
  );
}
