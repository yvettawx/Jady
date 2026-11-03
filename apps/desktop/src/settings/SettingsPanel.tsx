/* eslint-disable react-refresh/only-export-components -- the section registry lives with the panel that draws it */
// 设置 as a workspace tab (2026-10-26): sections on the left, the chosen one on the right, and a
// search over every setting's name. Every change takes effect at once; there is no Save.
import { useState } from "react";
import { useT } from "../i18n/context";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { TextField } from "../ui/TextField";
import { AiSection } from "./AiSection";
import { AppearanceSection, GeneralSection } from "./AppearanceSection";
import { SettingsQueryContext } from "./context";
import { ShortcutsSection } from "./ShortcutsSection";
import "./settings.css";

export interface SettingsSection {
  /** Its heading is the message `settings.section.<id>`. */
  id: string;
  icon: IconName;
  Body: () => React.ReactNode;
}

const SECTIONS: SettingsSection[] = [
  { id: "general", icon: "settings", Body: GeneralSection },
  { id: "appearance", icon: "sun", Body: AppearanceSection },
  { id: "shortcuts", icon: "keyboard", Body: ShortcutsSection },
];

/** Modules and plugins add a section the same way (CLAUDE.md: unified registration). */
export function registerSettingsSection(section: SettingsSection): () => void {
  const at = SECTIONS.findIndex((s) => s.id === section.id);
  if (at >= 0) SECTIONS[at] = section;
  else SECTIONS.push(section);
  return () => {
    const i = SECTIONS.indexOf(section);
    if (i >= 0) SECTIONS.splice(i, 1);
  };
}

/** The AI section comes with the AI gateway (P3); review pages show what it will be. */
export const registerAiSection = () =>
  registerSettingsSection({ id: "ai", icon: "ai", Body: AiSection });

export function SettingsPanel() {
  const t = useT();
  const [section, setSection] = useState("appearance");
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  return (
    <div className="dem-settings" data-focus-home="page" tabIndex={-1}>
      <nav className="dem-settings-nav" aria-label={t("settings.sections")}>
        <TextField
          aria-label={t("settings.search")}
          placeholder={t("settings.search")}
          icon="search"
          value={query}
          onChange={setQuery}
        />
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="dem-settings-tab"
                aria-current={!searching && section === s.id ? "page" : undefined}
                onClick={() => {
                  setQuery("");
                  setSection(s.id);
                }}
              >
                <Icon name={s.icon} size={16} />
                {t(`settings.section.${s.id}`)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="dem-settings-body" data-searching={searching || undefined}>
        <SettingsQueryContext.Provider value={query}>
          {SECTIONS.filter((s) => searching || s.id === section).map(({ id, Body }) => (
            <section key={id} className="dem-settings-section" aria-labelledby={`settings-${id}`}>
              <h2 id={`settings-${id}`} className="dem-settings-title">
                {t(`settings.section.${id}`)}
              </h2>
              <Body />
            </section>
          ))}
          <p className="dem-settings-none">{t("settings.search.none")}</p>
        </SettingsQueryContext.Provider>
      </div>
    </div>
  );
}
