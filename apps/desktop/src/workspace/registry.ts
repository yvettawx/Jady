// Panel components register here; the workspace draws every tab through this one registry,
// so modules and plugins add panels the same way (CLAUDE.md: unified registration).
import type { ComponentType } from "react";
import type { TabKind } from "../ui/ContentTab";
import type { IconName } from "../ui/icons";
import type { WorkspaceApi } from "./api";

export interface PanelProps {
  tabId: string;
  contentId: string;
  /** Preview, temporary or pinned; changes as the tab is promoted or pinned. */
  kind: TabKind;
  params: Record<string, unknown>;
  workspace: WorkspaceApi;
}

export interface PanelDefinition {
  /** Referred to by SavedTab.component. */
  id: string;
  icon?: IconName;
  /**
   * content: a piece of content (note, card, chat). widget: a tool such as 目录 or 大纲.
   * Content opened from a widget goes to the cell that last showed content, not the widget's.
   */
  role?: "content" | "widget";
  render: ComponentType<PanelProps>;
}

const panels = new Map<string, PanelDefinition>();

export function registerPanel(def: PanelDefinition): () => void {
  panels.set(def.id, def);
  return () => panels.delete(def.id);
}

export function panelDefinition(id: string): PanelDefinition | undefined {
  return panels.get(id);
}

export function panelDefinitions(): PanelDefinition[] {
  return [...panels.values()];
}
