import { useState } from "react";
import {
  Button as AriaButton,
  FieldError,
  Input,
  Label,
  Text,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "./Icon";
import "./field.css";

/** A password input with a show / hide button. Autocomplete and spell checking stay off. */
export function PasswordField({
  label,
  description,
  errorMessage,
  ...rest
}: Omit<AriaTextFieldProps, "className" | "style" | "children" | "type"> & {
  label: string;
  description?: string;
  errorMessage?: string;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <AriaTextField {...rest} type={shown ? "text" : "password"} className="dem-field">
      <Label className="dem-field-label">{label}</Label>
      <div className="dem-field-box">
        <Input className="dem-field-input" autoComplete="off" spellCheck={false} />
        <AriaButton
          className="dem-field-reveal"
          aria-label={t(shown ? "password.hide" : "password.show")}
          onPress={() => setShown((v) => !v)}
        >
          <Icon name={shown ? "hide" : "show"} size={14} />
        </AriaButton>
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
