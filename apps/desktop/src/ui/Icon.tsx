import { createElement } from "react";
import { resolveIcon, type IconName, type IconProps } from "./icons";

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className,
}: { name: IconName | (string & {}) } & Omit<IconProps, "aria-hidden">) {
  const component = resolveIcon(name);
  if (!component) return null;
  // Icons are decoration; the control that holds one carries the accessible name.
  return createElement(component, { size, strokeWidth, className, "aria-hidden": true });
}
