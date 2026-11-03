import type { ReactNode } from "react";
import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from "react-aria-components";
import "./switch.css";

export type SwitchProps = Omit<AriaSwitchProps, "className" | "style" | "children"> & {
  children: ReactNode;
};

export function Switch({ children, ...rest }: SwitchProps) {
  return (
    <AriaSwitch {...rest} className="dem-switch">
      <span className="dem-switch-track" aria-hidden>
        <span className="dem-switch-thumb" />
      </span>
      {children}
    </AriaSwitch>
  );
}
