// The one command registry (docs/05-design.md §4.4, CLAUDE.md): keyboard shortcuts, the
// launcher (P0.5-07-7) and later plugins all go through it. Shortcuts can be changed in
// Settings (M11: the shortcut table is data, checked for conflicts); everything that shows a
// shortcut reads it from here, so a change shows everywhere at once.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { IconName } from "../ui/icons";
import { IS_MAC } from "../ui/shortcut";

export interface Command {
  id: string;
  /** A message key or plain text for plugins without translations. */
  title: string;
  /** "Mod+Shift+E": Mod is ⌘ on macOS and Ctrl elsewhere. */
  shortcut?: string;
  icon?: IconName;
  run: () => void;
  /** Choices for an argument, as in `>切换空间 学习`; runWith gets the chosen id. */
  options?: () => { id: string; label: string }[];
  runWith?: (option: string) => void;
  /** Shortcut-only commands (⌘1 … ⌘9) stay out of the launcher's list. */
  hidden?: boolean;
  /** A message key naming its group in the shortcut table (通用 when left out). */
  group?: string;
  /**
   * Changes a setting (appearance, shortcuts, AI access, privacy…). Such commands are never
   * offered to AI, not even as proposals (CLAUDE.md; docs/05-design.md §5.7).
   */
  changesSettings?: boolean;
}

const registry = new Map<string, Command>();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};

export function registerCommand(cmd: Command): () => void {
  registry.set(cmd.id, cmd);
  changed();
  return () => {
    if (registry.get(cmd.id) !== cmd) return;
    registry.delete(cmd.id);
    changed();
  };
}

export const commands = (): Command[] => [...registry.values()];

/** What AI may be offered (P3 gateway): never commands that change settings. */
export const commandsForAi = (): Command[] => commands().filter((c) => !c.changesSettings);

// --- Shortcuts the user changed (Settings → 快捷键). null: the user removed the shortcut. ---
const STORE_KEY = "dem.settings.shortcuts";
const overrides = new Map<string, string | null>(
  (() => {
    try {
      return Object.entries(
        JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, string | null>,
      );
    } catch {
      return [];
    }
  })(),
);
const persist = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(overrides)));
  } catch {
    // Only a development convenience; P1 keeps settings in the library.
  }
};

/** The shortcut in effect: the user's own, else the command's default. */
export function shortcutOf(id: string): string | undefined {
  if (overrides.has(id)) return overrides.get(id) ?? undefined;
  return registry.get(id)?.shortcut;
}
export const isShortcutChanged = (id: string) => overrides.has(id);
export function setShortcut(id: string, spec: string | null): void {
  overrides.set(id, spec);
  persist();
  changed();
}
/** Back to the default for one command, or for all of them. */
export function resetShortcut(id?: string): void {
  if (id) overrides.delete(id);
  else overrides.clear();
  persist();
  changed();
}

const MOD_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];
/** One spelling per shortcut: modifiers in a fixed order, letters upper-case. */
export function normalizeShortcut(spec: string): string {
  const parts = spec.split("+");
  const key = parts.at(-1) ?? "";
  const mods = parts.slice(0, -1).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** Another command already on this shortcut, if any. */
export function findConflict(spec: string, exceptId?: string): Command | undefined {
  const want = normalizeShortcut(spec);
  return commands().find((c) => {
    const s = shortcutOf(c.id);
    return c.id !== exceptId && s !== undefined && normalizeShortcut(s) === want;
  });
}

const CODE_KEYS: Record<string, string> = {
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/**
 * A shortcut spec from a key press, for recording one in Settings. Null for a lone key or a
 * modifier on its own: every shortcut needs ⌘/Ctrl or ⌥/Alt (docs/05-design.md §11.1).
 */
export function shortcutFromEvent(e: KeyboardEvent, mac = IS_MAC): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (mac && e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (!mods.some((m) => m !== "Shift")) return null;
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3)
    : /^Digit\d$/.test(e.code)
      ? e.code.slice(5)
      : (CODE_KEYS[e.code] ?? e.key);
  return normalizeShortcut([...mods, key].join("+"));
}

const subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
/** Re-renders when commands or shortcuts change. */
export function useCommandsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
/** The shortcut in effect for one command, kept current. */
export function useShortcut(id: string): string | undefined {
  useCommandsVersion();
  return shortcutOf(id);
}

/** Does a key event match a shortcut spec on this platform? */
export function matchesShortcut(e: KeyboardEvent, spec: string, mac = IS_MAC): boolean {
  const parts = spec.split("+");
  const key = parts.at(-1) ?? "";
  const want = new Set(parts.slice(0, -1));
  const wantMeta = mac ? want.has("Mod") || want.has("Cmd") : want.has("Cmd");
  const wantCtrl = mac ? want.has("Ctrl") : want.has("Mod") || want.has("Ctrl");
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) return false;
  if (e.shiftKey !== want.has("Shift") || e.altKey !== want.has("Alt")) return false;
  // e.code is layout-independent for letters and digits ("KeyE", "Digit1"); "\\" is Backslash.
  const code =
    key === "\\"
      ? "Backslash"
      : /^[A-Z]$/.test(key)
        ? `Key${key}`
        : /^\d$/.test(key)
          ? `Digit${key}`
          : key;
  return e.code === code || e.key.toLowerCase() === key.toLowerCase();
}

/** Registers a command for as long as the component is mounted; `run` may change freely. */
export function useCommand(cmd: Command): void {
  const latest = useRef(cmd);
  useEffect(() => {
    latest.current = cmd;
  });
  useEffect(
    () => registerCommand({ ...cmd, run: () => latest.current.run() }),
    // Re-register only when what the registry shows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cmd.id, cmd.title, cmd.shortcut, cmd.icon],
  );
}

/** One window-level listener that runs the command whose shortcut was pressed. */
export function useCommandKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const c of registry.values()) {
        const spec = shortcutOf(c.id);
        if (spec && matchesShortcut(e, spec)) {
          e.preventDefault();
          c.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
