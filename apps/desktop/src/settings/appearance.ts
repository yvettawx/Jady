// 外观 (docs/05-design.md §15, A.6, B.3, B.4) and the interface language, in one place: the
// Settings page changes them, and everything else follows. Defaults are for a new user. Kept
// in this browser for now; P1 keeps settings in the library.
import { useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, LANG_TAG, type Locale } from "../i18n/messages";
import { applyFont, FONT_SLOTS, type FontSlot } from "../theme/fonts.ts";
import { applyVars } from "../theme/runtime.ts";
import { DEFAULT_SCHEME, type SchemeId } from "../theme/tokens.ts";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "../ui/glass/settings";

export type Density = "compact" | "regular" | "comfortable";

export interface Appearance {
  /** 跟随系统 by default. */
  mode: "system" | "light" | "dark";
  scheme: SchemeId;
  glass: GlassSettings;
  /** 溢光: 0–1 of the theme's full strength, for the star map and the heat map. */
  glow: number;
  /** 首页场景. */
  homeScene: "starmap" | "none";
  /** 页签排法: the 打开的内容 list by default (§3.2), or tabs above each cell. */
  tabs: "vertical" | "horizontal";
  /** A font family per slot, or null for the default chain. */
  fonts: Record<FontSlot, string | null>;
  /** 字号: one of FONT_SCALES. */
  fontScale: number;
  density: Density;
  locale: Locale;
  /** 自定义 CSS 片段 (PRD H5): applied last, so it can change anything. */
  customCss: string;
}

/**
 * A new user's settings. The language starts as Chinese: English ships with the open-source
 * release (PRD H7), and then a new user's language can follow the system's.
 */
export function defaultAppearance(): Appearance {
  return {
    mode: "system",
    scheme: DEFAULT_SCHEME,
    glass: DEFAULT_GLASS_SETTINGS,
    glow: 1,
    homeScene: "starmap",
    tabs: "vertical",
    fonts: { ui: null, long: null, display: null, mono: null },
    fontScale: 1,
    density: "regular",
    locale: systemLocale(),
    customCss: "",
  };
}

/** A new user gets the language their computer uses, when the app has it. */
function systemLocale(): Locale {
  const lang = typeof navigator === "undefined" ? "" : navigator.language;
  if (!lang) return DEFAULT_LOCALE;
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

const KEY = "dem.settings.appearance";
function load(): Appearance {
  const base = defaultAppearance();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Appearance>;
    return {
      ...base,
      ...saved,
      glass: { ...base.glass, ...saved.glass },
      fonts: { ...base.fonts, ...saved.fonts },
    };
  } catch {
    return base;
  }
}

let current = load();
const listeners = new Set<() => void>();

export const getAppearance = () => current;

export function setAppearance(patch: Partial<Appearance>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // A development convenience only.
  }
  listeners.forEach((f) => f());
}

export function resetAppearance(): void {
  setAppearance(defaultAppearance());
}

const subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}

/** Applies what CSS can carry: mode, font size, density and fonts. Returns an undo. */
export function applyAppearance(a: Appearance, root: HTMLElement): () => void {
  root.lang = LANG_TAG[a.locale];
  if (a.mode === "system") delete root.dataset.theme;
  else root.dataset.theme = a.mode;
  if (a.density === "regular") delete root.dataset.density;
  else root.dataset.density = a.density;
  for (const slot of FONT_SLOTS) applyFont(slot, a.fonts[slot], root);
  return applyVars(root, { "--dem-font-scale": String(a.fontScale) });
}
