// Menus are data: a plugin or command can hand over a list of entries without touching JSX.
// MenuButton opens one from a button; ContextMenu opens one at the pointer (right click) or,
// from the keyboard, under the focused element (the context-menu key or Shift+F10).
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  Keyboard,
  Menu as AriaMenu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
  SubmenuTrigger,
  Text,
  type Key,
} from "react-aria-components";
import { Button, type ButtonVariant } from "./Button";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { formatShortcut } from "./shortcut";
import "./overlay.css";
import "./menu.css";

export type MenuEntry =
  | {
      kind?: "item";
      id: string;
      label: string;
      icon?: IconName;
      /** As "Mod+Shift+K"; shown per platform. */
      shortcut?: string;
      isDisabled?: boolean;
      /** A short line under the label, e.g. why the item is unavailable. */
      note?: string;
      danger?: boolean;
      children?: MenuEntry[];
    }
  | { kind: "separator"; id: string };

function renderEntries(entries: MenuEntry[], onAction: (id: Key) => void): ReactNode[] {
  return entries.map((e) => {
    if (e.kind === "separator") return <Separator key={e.id} className="dem-menu-separator" />;
    const item = (
      <MenuItem
        key={e.id}
        id={e.id}
        textValue={e.label}
        isDisabled={e.isDisabled}
        className="dem-menu-item"
        data-danger={e.danger || undefined}
      >
        <span className="dem-menu-icon">{e.icon && <Icon name={e.icon} size={14} />}</span>
        <span className="dem-menu-text">
          <Text slot="label">{e.label}</Text>
          {e.note && (
            <Text slot="description" className="dem-menu-note">
              {e.note}
            </Text>
          )}
        </span>
        {e.shortcut && <Keyboard className="dem-menu-kbd">{formatShortcut(e.shortcut)}</Keyboard>}
        {e.children && <Icon name="chevron-right" size={14} className="dem-menu-sub" />}
      </MenuItem>
    );
    if (!e.children) return item;
    return (
      <SubmenuTrigger key={e.id}>
        {item}
        <Popover className="dem-popover dem-menu-popover" offset={-4}>
          <AriaMenu className="dem-menu" onAction={(id) => onAction(id)}>
            {renderEntries(e.children, onAction)}
          </AriaMenu>
        </Popover>
      </SubmenuTrigger>
    );
  });
}

export function MenuList({
  items,
  onAction,
  "aria-label": ariaLabel,
}: {
  items: MenuEntry[];
  onAction: (id: Key) => void;
  "aria-label"?: string;
}) {
  return (
    // React Aria passes extra arguments to onAction; callers get the item id only.
    <AriaMenu
      className="dem-menu"
      onAction={(id) => onAction(id)}
      aria-label={ariaLabel}
      autoFocus="first"
    >
      {renderEntries(items, onAction)}
    </AriaMenu>
  );
}

/** A button that opens a menu; with no visible label it needs an aria-label. */
export type MenuButtonProps = {
  items: MenuEntry[];
  onAction: (id: Key) => void;
  icon?: IconName;
  variant?: ButtonVariant;
} & ({ label: string } | { label?: never; "aria-label": string });

export function MenuButton({ items, onAction, icon, variant = "quiet", ...rest }: MenuButtonProps) {
  return (
    <MenuTrigger>
      {"label" in rest && rest.label ? (
        <Button variant={variant} icon={icon}>
          {rest.label}
        </Button>
      ) : (
        <Button
          variant={variant}
          icon={icon ?? "more"}
          aria-label={(rest as { "aria-label": string })["aria-label"]}
        />
      )}
      <Popover className="dem-popover dem-menu-popover" placement="bottom start" offset={4}>
        <MenuList items={items} onAction={onAction} />
      </Popover>
    </MenuTrigger>
  );
}

export function ContextMenu({
  items,
  onAction,
  "aria-label": ariaLabel,
  children,
}: {
  items: MenuEntry[];
  onAction: (id: Key) => void;
  "aria-label": string;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const open = (e: MouseEvent) => {
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY });
  };
  const openFromKeys = (e: KeyboardEvent) => {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    e.preventDefault();
    const r = (e.target as HTMLElement).getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom });
  };
  return (
    <div className="dem-context-area" onContextMenu={open} onKeyDown={openFromKeys}>
      {children}
      <span
        ref={anchor}
        className="dem-context-anchor"
        style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
      />
      <Popover
        className="dem-popover dem-menu-popover"
        triggerRef={anchor}
        isOpen={at !== null}
        onOpenChange={(isOpen) => !isOpen && setAt(null)}
        placement="bottom start"
        offset={2}
      >
        {/* No MenuTrigger around this one, so choosing an item has to close it here. */}
        <MenuList
          items={items}
          onAction={(id) => {
            setAt(null);
            onAction(id);
          }}
          aria-label={ariaLabel}
        />
      </Popover>
    </div>
  );
}
