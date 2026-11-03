// Puts the appearance settings into effect for everything inside: the colour mode, font size,
// density and fonts on <html>, and the interface language for our strings and React Aria's.
import { useEffect, type ReactNode } from "react";
import { I18nProvider } from "../i18n/I18nProvider";
import { installFocusRescue } from "../ui/focus";
import { applyAppearance, useAppearance } from "./appearance";

export function AppearanceRoot({ children }: { children: ReactNode }) {
  const a = useAppearance();
  useEffect(() => applyAppearance(a, document.documentElement), [a]);
  useEffect(() => installFocusRescue(), []);
  return (
    <I18nProvider locale={a.locale}>
      {a.customCss && <style data-custom-css>{a.customCss}</style>}
      {children}
    </I18nProvider>
  );
}
