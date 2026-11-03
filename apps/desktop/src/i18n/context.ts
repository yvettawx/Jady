import { createContext, useContext } from "react";
import { DEFAULT_LOCALE, translate, type Translate } from "./messages";

export const I18nContext = createContext<{ locale: string; t: Translate }>({
  locale: DEFAULT_LOCALE,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
});

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLocale(): string {
  return useContext(I18nContext).locale;
}
