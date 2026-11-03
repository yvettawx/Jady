import { useContext, useEffect, useRef, type ReactElement } from "react";
import {
  OverlayArrow,
  Tooltip as AriaTooltip,
  TooltipTrigger,
  TooltipTriggerStateContext,
  type TooltipProps as AriaTooltipProps,
} from "react-aria-components";
import { formatShortcut } from "./shortcut";
import "./overlay.css";
import "./tooltip.css";

/**
 * Switching tabs can hide a button while it still has focus (WebKit fires no blur then). Its
 * tooltip would sit in the window's corner and take the next Esc, so it closes with the button.
 */
function CloseWithTrigger() {
  const state = useContext(TooltipTriggerStateContext);
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const check = () => {
      const id = mark.current?.closest(".dem-tooltip")?.id;
      if (!id) return;
      const trigger = document.querySelector(`[aria-describedby~="${id}"]`);
      if (!trigger?.checkVisibility()) state?.close(true);
    };
    const timer = setInterval(check, 150);
    return () => clearInterval(timer);
  }, [state]);
  return <span ref={mark} hidden />;
}

/**
 * Name and shortcut on hover or keyboard focus (docs/05-design.md §2.3). The child must be a
 * focusable React Aria element, such as our Button.
 */
export function Tooltip({
  label,
  shortcut,
  placement = "top",
  delay = 600,
  children,
}: {
  label: string;
  /** As "Mod+K"; shown per platform. */
  shortcut?: string;
  placement?: AriaTooltipProps["placement"];
  delay?: number;
  children: ReactElement;
}) {
  return (
    <TooltipTrigger delay={delay} closeDelay={150}>
      {children}
      <AriaTooltip className="dem-tooltip" placement={placement} offset={6}>
        <OverlayArrow className="dem-tooltip-arrow">
          <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden>
            <path d="M0 0 L4 4 L8 0" />
          </svg>
        </OverlayArrow>
        <CloseWithTrigger />
        {label}
        {shortcut && <kbd className="dem-tooltip-kbd">{formatShortcut(shortcut)}</kbd>}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
