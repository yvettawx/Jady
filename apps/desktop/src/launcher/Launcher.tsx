// 启动器 (docs/05-design.md §4): one box for searching, opening, running commands, creating
// and asking AI. The input is a combobox over a list of results grouped by source; keys as in
// §4.3: ↑↓ choose, ↵ run or open, ⌘↵ new tab, ⇧↵ split, Tab completes, Esc closes. Keys are
// ignored while an input method is composing, so picking 汉字 never runs anything.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useT } from "../i18n/context";
import { PrivacyMark, type PrivacyLevel } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { formatShortcut, IS_MAC } from "../ui/shortcut";
import { normalizeSymbols, parseQuery, type LauncherMode } from "./query";
import {
  searchAll,
  sourcesVersion,
  subscribeSources,
  type LauncherItem,
  type OpenHow,
} from "./sources";
import "./launcher.css";

const MODE_ICON: Record<Exclude<LauncherMode, "search">, IconName> = {
  command: "command",
  ask: "ai",
  "ai-command": "ai",
  new: "plus",
  tag: "tag",
  scope: "filter",
};

function Highlighted({ text, ranges = [] }: { text: string; ranges?: [number, number][] }) {
  if (!ranges.length) return <>{text}</>;
  const chars = [...text];
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(chars.slice(at, a).join(""));
    out.push(<mark key={i}>{chars.slice(a, b).join("")}</mark>);
    at = b;
  });
  if (at < chars.length) out.push(chars.slice(at).join(""));
  return <>{out}</>;
}

function LauncherBox({
  initial,
  privacy,
  close,
}: {
  initial: string;
  privacy: PrivacyLevel;
  close: () => void;
}) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(initial);
  const [active, setActive] = useState(0);
  const query = useMemo(() => parseQuery(text), [text]);
  const version = useSyncExternalStore(subscribeSources, sourcesVersion);
  const items = useMemo(
    () =>
      searchAll(query, {
        privacy,
        setInput: (s) => {
          setText(s);
          setActive(0);
        },
        close,
      }),
    // version: sources registered after the launcher opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, privacy, close, version],
  );
  const current = items[Math.min(active, items.length - 1)];
  // The symbols and the scope show as chips, not as text: the input holds only what follows.
  const norm = normalizeSymbols(text).replace(/^\s+/, "");
  const head = norm.slice(0, norm.length - query.text.length);
  const setRest = (rest: string) => {
    setText(head + rest);
    setActive(0);
  };
  /** Backspace at the very start takes off the last chip: the mode first, then the scope. */
  const dropChip = () => {
    const next =
      query.mode === "scope"
        ? ""
        : query.mode !== "search"
          ? head.replace(/(\?\/|[>?+#])\s*$/, "")
          : head.replace(/@\S+\s+$/, "");
    setText(next + query.text);
    setActive(0);
  };

  const run = (item: LauncherItem | undefined, how: OpenHow) => {
    if (!item || item.disabledReason) return;
    item.run(how);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const input = e.currentTarget;
    if (e.key === "Backspace" && head && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      dropChip();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (Math.min(a, items.length - 1) + step + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(current, mod ? "tab" : e.shiftKey ? "split" : "open");
    }
  };
  // Tab completes. It is taken on the input itself, before the dialog's focus trap (higher up)
  // would move the focus and select the input's text.
  const inputRef = useRef<HTMLInputElement>(null);
  const completeRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    completeRef.current = current?.complete;
  });
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onTab = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Tab" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      const c = completeRef.current;
      if (c) {
        setText(c);
        setActive(0);
      }
    };
    el.addEventListener("keydown", onTab);
    return () => el.removeEventListener("keydown", onTab);
  }, []);

  const modeLabel = query.mode === "search" ? null : t(`launcher.mode.${query.mode}`);
  return (
    <div className="dem-launcher-box">
      <div className="dem-launcher-field">
        <Icon name="search" size={16} className="dem-launcher-search" />
        {query.scope && <span className="dem-launcher-scope">@{query.scope}</span>}
        {modeLabel && query.mode !== "search" && (
          <span className="dem-launcher-mode">
            <Icon name={MODE_ICON[query.mode]} size={12} />
            {modeLabel}
          </span>
        )}
        <input
          ref={inputRef}
          className="dem-launcher-input"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={current ? `${id}-${current.id}` : undefined}
          aria-autocomplete="list"
          aria-label={t("launcher.label")}
          placeholder={
            query.mode === "search" && !query.scope
              ? t("launcher.placeholder")
              : t(`launcher.hint.${query.mode}`)
          }
          autoFocus
          spellCheck={false}
          value={query.text}
          onChange={(e) => setRest(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        className="dem-launcher-results"
        id={`${id}-list`}
        role="listbox"
        aria-label={t("launcher.results")}
      >
        {items.length === 0 && (
          <p className="dem-launcher-empty">{t(`launcher.empty.${query.mode}`)}</p>
        )}
        {items.map((it, i) => {
          const heading = items[i - 1]?.group !== it.group ? it.group : null;
          return (
            <div key={it.id} role="presentation">
              {heading && (
                <p className="dem-launcher-group" role="presentation">
                  {heading}
                </p>
              )}
              <div
                id={`${id}-${it.id}`}
                role="option"
                aria-selected={it === current}
                aria-disabled={it.disabledReason ? true : undefined}
                className="dem-launcher-item"
                data-active={it === current || undefined}
                onPointerMove={() => setActive(i)}
                onClick={(e) =>
                  run(it, (IS_MAC ? e.metaKey : e.ctrlKey) ? "tab" : e.shiftKey ? "split" : "open")
                }
              >
                {it.icon && <Icon name={it.icon} size={16} className="dem-launcher-icon" />}
                <span className="dem-launcher-text">
                  <span className="dem-launcher-title">
                    <Highlighted text={it.title} ranges={it.ranges} />
                  </span>
                  {it.privacy && it.privacy !== "normal" && <PrivacyMark level={it.privacy} />}
                  {it.disabledReason && (
                    <span className="dem-launcher-note">{it.disabledReason}</span>
                  )}
                </span>
                {it.meta && <span className="dem-launcher-meta">{it.meta}</span>}
                {it.shortcut && (
                  <kbd className="dem-launcher-kbd">{formatShortcut(it.shortcut)}</kbd>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Launcher({
  isOpen,
  onOpenChange,
  initial = "",
  session = 0,
  privacy = "normal",
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Text to start with, e.g. "+" for ⌘N. */
  initial?: string;
  /** Changes with every opening, so each one starts afresh. */
  session?: number;
  /** The level of the content it was opened from. */
  privacy?: PrivacyLevel;
}) {
  const t = useT();
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="dem-launcher-overlay"
    >
      <Modal className="dem-launcher">
        <Dialog aria-label={t("launcher.label")} className="dem-launcher-dialog">
          {({ close }) => (
            <LauncherBox
              key={`${session}:${initial}`}
              initial={initial}
              privacy={privacy}
              close={close}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
