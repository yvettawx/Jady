// What a plugin gets (docs/extending/plugin-api.md). Everything goes through the same registries the
// app itself uses, and whatever a plugin registers goes away again when it stops: when the library
// locks, for one. Data comes from the same core facade as the interface; there is no other door.
import type { ReactNode } from "react";
import type { ChatStart } from "../app/ai/chats";
import { api, itemsChanged, onItemsChanged } from "../app/api";
import { askInWindow } from "../app/panels/AiPanels";
import { registerWeeklyStep } from "../app/panels/ReviewView";
import { registerNavView, type NavView } from "../app/navViews";
import { registerHomeWidget } from "../home/registry";
import type { HomeWidget } from "../home/HomeGrid";
import { addMessages, type Translate } from "../i18n/messages";
import { registerSource, type LauncherSource } from "../launcher/sources";
import { registerSettingsSection, type SettingsSection } from "../settings/SettingsPanel";
import { registerCommand, type Command } from "../shell/commands";
import { registerScheme, type SchemeSets } from "../theme/tokens.ts";
import { showToast, type ToastContent } from "../ui/toast";
import type { WorkspaceApi } from "../workspace/api";
import { registerPanel, type PanelDefinition } from "../workspace/registry";
import { registerTemplate, type Template } from "../app/life/templates";

/** The part of the core a plugin may use. 机密 items come without titles in lists, as everywhere. */
export interface PluginData {
  itemList: typeof api.itemList;
  itemGet: typeof api.itemGet;
  itemCreate: typeof api.itemCreate;
  itemUpdate: typeof api.itemUpdate;
  search: typeof api.search;
  backlinks: typeof api.backlinks;
  tagList: typeof api.tagList;
  typeList: typeof api.typeList;
  /** Say that items changed after writing, so lists refresh. */
  changed: () => void;
  /** Runs `f` whenever an item changes. Stops by itself with the plugin. */
  onChanged: (f: () => void) => void;
}

export interface PluginContext {
  t: Translate;
  data: PluginData;
  /** The workspace, once the window has one. */
  workspace: () => WorkspaceApi | null;
  /** Adds interface text for a language. Keys should start with the plugin's id. */
  addMessages: (locale: string, messages: Record<string, string>) => void;
  registerPanel: (def: PanelDefinition) => void;
  registerCommand: (cmd: Command) => void;
  registerLauncherSource: (source: LauncherSource) => void;
  registerHomeWidget: (widget: HomeWidget) => void;
  registerNavView: (view: NavView) => void;
  registerSettingsSection: (section: SettingsSection) => void;
  /** Three colour sets; the name is the message `scheme.<id>`. */
  registerScheme: (id: string, sets: SchemeSets) => void;
  toast: (content: ToastContent) => void;
  /** Opens a chat in a window. AI sees only what the gateway lets it, the same as any chat. */
  ask: (start: ChatStart, first?: string) => Promise<string>;
  /** Adds a step to the weekly review; its title is the message `review.step.<id>`. */
  registerWeeklyStep: (id: string, render: () => ReactNode) => void;
  /** A set of types people can add from the settings. See docs/extending/templates.md. */
  registerTemplate: (template: Template) => void;
}

/**
 * Goes up when something a plugin uses changes in a way that can break it. Additions do not count.
 * See docs/extending/plugin-api.md.
 */
export const PLUGIN_API_VERSION = 1;

export interface Plugin {
  /** Short and unique, in lowercase with hyphens. */
  id: string;
  /** The version this plugin was written for. A newer one than the app has is not started. */
  apiVersion?: number;
  /** Runs when a library opens. May return something to run when it stops. */
  activate: (ctx: PluginContext) => (() => void) | undefined;
}

export const definePlugin = (plugin: Plugin) => plugin;

export type { ReactNode };

/** Starts a plugin; the returned function undoes everything it registered. */
export function startPlugin(
  plugin: Plugin,
  host: { t: Translate; workspace: () => WorkspaceApi | null },
): () => void {
  const undo: (() => void)[] = [];
  function track<A>(register: (a: A) => () => void) {
    return (a: A) => {
      undo.push(register(a));
    };
  }
  const ctx: PluginContext = {
    t: host.t,
    workspace: host.workspace,
    addMessages,
    data: {
      itemList: api.itemList,
      itemGet: api.itemGet,
      itemCreate: api.itemCreate,
      itemUpdate: api.itemUpdate,
      search: api.search,
      backlinks: api.backlinks,
      tagList: api.tagList,
      typeList: api.typeList,
      changed: itemsChanged,
      onChanged: (f) => undo.push(onItemsChanged(f)),
    },
    registerPanel: track(registerPanel),
    registerCommand: track(registerCommand),
    registerLauncherSource: track(registerSource),
    registerHomeWidget: track(registerHomeWidget),
    registerNavView: track(registerNavView),
    registerSettingsSection: track(registerSettingsSection),
    registerScheme: (id, sets) => undo.push(registerScheme(id, sets)),
    toast: (content) => void showToast(content),
    ask: askInWindow,
    registerWeeklyStep: (id, render) => undo.push(registerWeeklyStep(id, render)),
    registerTemplate: (template) => undo.push(registerTemplate(template)),
  };
  const stop = plugin.activate(ctx);
  return () => {
    if (stop) stop();
    undo.reverse().forEach((f) => f());
  };
}
