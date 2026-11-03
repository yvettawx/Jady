// Shortcuts are written once as "Mod+Shift+K" and shown per platform:
// ⌘⇧K on macOS, Ctrl+Shift+K elsewhere (docs/05-design.md §13).
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC: Record<string, string> = {
  Mod: "⌘",
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const OTHER: Record<string, string> = {
  Mod: "Ctrl",
  Cmd: "Win",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export function formatShortcut(spec: string, mac = IS_MAC): string {
  const keys = spec
    .split("+")
    .map((k) => (mac ? MAC[k] : OTHER[k]) ?? (k.length === 1 ? k.toUpperCase() : k));
  return keys.join(mac ? "" : "+");
}
