import { useMemo, type ReactNode } from "react";
import { I18nProvider as AriaI18nProvider } from "react-aria-components";
import { I18nContext } from "./context";
import { translate, type Translate } from "./messages";

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const value = useMemo(() => {
    const t: Translate = (key, vars) => translate(locale, key, vars);
    return { locale, t };
  }, [locale]);
  // React Aria has its own strings (e.g. "Dismiss") and date and number formats; keep them in step.
  return (
    <I18nContext.Provider value={value}>
      <AriaI18nProvider locale={locale}>{children}</AriaI18nProvider>
    </I18nContext.Provider>
  );
}
