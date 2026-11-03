// Interface text lives in per-language message files, never in components (PRD H7).
// zh-CN is the reference: its keys define MessageKey, and every other language must have the
// same keys (checked in i18n.test.tsx). Plugins add their own keys with addMessages.
import en from "./en.json";
import zhCN from "./zh-CN.json";

export type MessageKey = keyof typeof zhCN;
export type Locale = "zh-CN" | "en";
export const DEFAULT_LOCALE: Locale = "zh-CN";
/**
 * What goes in <html lang>. WebKit reads "zh-CN" as "whichever Chinese the system prefers" and
 * draws centred Traditional punctuation on a Mac set to Traditional; "zh-Hans" is always right.
 */
export const LANG_TAG: Record<Locale, string> = { "zh-CN": "zh-Hans", en: "en" };

const catalogs: Record<string, Record<string, string>> = { "zh-CN": { ...zhCN }, en: { ...en } };

export function addMessages(locale: string, messages: Record<string, string>): void {
  catalogs[locale] = { ...catalogs[locale], ...messages };
}

/** Looks a key up in `locale`, then the default language, then shows the key itself. */
export function translate(
  locale: string,
  key: MessageKey | (string & {}),
  vars?: Record<string, string | number>,
): string {
  const text = catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, v: string) => String(vars[v] ?? m)) : text;
}

export type Translate = (
  key: MessageKey | (string & {}),
  vars?: Record<string, string | number>,
) => string;
