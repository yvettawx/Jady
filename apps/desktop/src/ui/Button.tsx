import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

type Common = Omit<AriaButtonProps, "className" | "style" | "children"> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: IconName;
};

/** A button with text, or an icon-only button, which must then have an accessible name. */
export type ButtonProps = Common &
  ({ children: ReactNode } | { children?: never; "aria-label": string });

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  ...rest
}: ButtonProps) {
  return (
    <AriaButton
      {...rest}
      className="dem-button"
      data-variant={variant}
      data-size={size}
      data-icon-only={children === undefined || undefined}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </AriaButton>
  );
}
