// 状态栏 (docs/05-design.md §2.4): status only, no entry points. Left follows the current
// content, right follows the whole app. Items are spaced apart, never joined with dots.
import type { ReactNode } from "react";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import "./statusbar.css";

export function StatusBar({ left, right }: { left: ReactNode[]; right: ReactNode[] }) {
  return (
    <footer className="dem-statusbar">
      <div className="dem-statusbar-side">
        {left.map((x, i) => (
          <span key={i} className="dem-statusbar-item">
            {x}
          </span>
        ))}
      </div>
      <div className="dem-statusbar-side">
        {right.map((x, i) => (
          <span key={i} className="dem-statusbar-item">
            {x}
          </span>
        ))}
      </div>
    </footer>
  );
}

/** A small coloured dot before a status, e.g. the current space or AI running. */
export function StatusDot({ color }: { color: string }) {
  return <span className="dem-status-dot" style={{ background: color }} aria-hidden />;
}

/** A status that opens its details on click, e.g. where AI is running. Still not an entry point. */
export function StatusDetail({ children, details }: { children: ReactNode; details: ReactNode }) {
  return (
    <DialogTrigger>
      <AriaButton className="dem-status-detail">{children}</AriaButton>
      <Popover className="dem-popover dem-status-popover" placement="top end" offset={8}>
        <Dialog className="dem-status-dialog">{details}</Dialog>
      </Popover>
    </DialogTrigger>
  );
}
