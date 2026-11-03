import { createContext, useContext } from "react";
import { match } from "../launcher/match";
import type { Space } from "../shell/spaces";

/** What the settings page needs from the window around it: the spaces and their colours. */
export interface SettingsHost {
  spaces: Space[];
  space: string;
  setSpaceColor: (id: string, color: number | string) => void;
  renameSpace?: (id: string, name: string) => void;
  /** Left out while it is the only space. */
  deleteSpace?: (id: string) => void;
}

export const SettingsHostContext = createContext<SettingsHost | null>(null);
export const useSettingsHost = () => useContext(SettingsHostContext);

/** The settings search, so each row can tell whether it matches. */
export const SettingsQueryContext = createContext("");

/** Does a setting's name or keywords match the search (pinyin initials too)? */
export function rowMatches(query: string, label: string, keywords: string[] = []): boolean {
  return !query.trim() || [label, ...keywords].some((x) => match(query, x) !== null);
}
