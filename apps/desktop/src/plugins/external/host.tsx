// External plugins (docs/spikes/plugin-sandbox.md). Each runs in a frame sandboxed without the same
// origin, loaded from the jadyplugin: protocol, and reaches the app only through the messages handled
// here. This side only routes: what a plugin may do with data is checked again in Rust
// (plugin_call), against what the user granted it.
import { useLayoutEffect, useRef } from "react";
import type { Manifest } from "../../bindings";
import { openById } from "../../app/actions";
import { api, onItemsChanged } from "../../app/api";
import type { Translate } from "../../i18n/messages";
import { registerCommand } from "../../shell/commands";
import { Icon } from "../../ui/Icon";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import { registerPanel } from "../../workspace/registry";
import "./plugin.css";

interface Host {
  t: Translate;
  locale: string;
  workspace: () => WorkspaceApi | null;
}

interface Frame {
  manifest: Manifest;
  /** `null` for the background page that runs commands. */
  panel: string | null;
}

const frames = new Map<Window, Frame>();
let host: Host | null = null;

/** Where a plugin's files load from. The probes serve them from their own bridge instead. */
export function pluginUrl(id: string, path: string): string {
  const base =
    (window as { __JADY_PLUGIN_BASE__?: string }).__JADY_PLUGIN_BASE__ ??
    (navigator.userAgent.includes("Windows")
      ? "http://jadyplugin.localhost/"
      : "jadyplugin://localhost/");
  return `${base}${id}/${path}`;
}

/** A manifest's text in this language, the language without its region, English or anything. */
export function localized(text: Record<string, string> | undefined, locale: string): string {
  if (!text) return "";
  return (
    text[locale] ?? text[locale.split("-")[0] ?? ""] ?? text.en ?? Object.values(text)[0] ?? ""
  );
}

export const panelId = (plugin: string, panel: string) => `plugin:${plugin}:${panel}`;

/** The app's design tokens, so a plugin page looks at home: every --dem-* variable in effect. */
function tokens(): Record<string, string> {
  const names = new Set<string>();
  const collect = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule)
        for (const name of Array.from(rule.style)) if (name.startsWith("--dem-")) names.add(name);
      if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules);
    } catch {
      // A sheet from elsewhere cannot be read; ours all can.
    }
  }
  const root = document.documentElement;
  for (const name of Array.from(root.style)) if (name.startsWith("--dem-")) names.add(name);
  const style = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const name of names) out[name] = style.getPropertyValue(name).trim();
  return out;
}

const post = (w: Window, message: object) => w.postMessage({ jady: 1, ...message }, "*");

function broadcast(message: object, only?: (f: Frame) => boolean) {
  for (const [w, f] of frames) if (!only || only(f)) post(w, message);
}

async function call(plugin: string, method: string, args: unknown): Promise<unknown> {
  return JSON.parse(await api.pluginCall(plugin, method, JSON.stringify(args ?? {}))) as unknown;
}

function openPanel(m: Manifest, panel: string) {
  const decl = m.panels?.find((p) => p.id === panel);
  if (!decl || !host) throw new Error(`no panel ${panel}`);
  host.workspace()?.open({
    contentId: panelId(m.id, panel),
    component: panelId(m.id, panel),
    title: localized(decl.title, host.locale),
  });
}

async function handle(f: Frame, method: string, args: Record<string, unknown>): Promise<unknown> {
  const m = f.manifest;
  if (method.startsWith("items.")) return call(m.id, method.slice("items.".length), args);
  if (method === "storage.get" || method === "storage.set") return call(m.id, method, args);
  if (!host) throw new Error("the library is locked");
  const name = localized(m.name, host.locale);
  switch (method) {
    case "ui.toast":
      // Always under the plugin's name, so it cannot pass for the app.
      showToast({ text: host.t("plugins.says", { name, text: String(args.text).slice(0, 200) }) });
      return null;
    case "ui.openItem": {
      const id = String(args.id);
      // Only what the plugin itself may read.
      await call(m.id, "get", { id });
      const ws = host.workspace();
      if (ws) openById(ws, host.t, id);
      return null;
    }
    case "ui.openPanel":
      openPanel(m, String(args.id));
      return null;
    default:
      throw new Error(`no method ${method}`);
  }
}

function onMessage(e: MessageEvent) {
  const source = e.source as Window | null;
  const f = source ? frames.get(source) : undefined;
  const m = e.data as {
    jady?: number;
    hello?: boolean;
    id?: unknown;
    method?: unknown;
    args?: unknown;
  };
  if (!source || !f || !m || m.jady !== 1 || !host) return;
  if (m.hello) {
    post(source, {
      event: "init",
      info: { plugin: f.manifest.id, panel: f.panel, locale: host.locale, theme: tokens() },
    });
    return;
  }
  if (typeof m.id !== "number" || typeof m.method !== "string") return;
  const id = m.id;
  const args = m.args && typeof m.args === "object" ? (m.args as Record<string, unknown>) : {};
  handle(f, m.method, args)
    .then((value) => post(source, { reply: id, ok: true, value }))
    .catch((err: unknown) =>
      post(source, {
        reply: id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}

/** One of a plugin's panels: its name always shows above the page, which draws the rest. */
function PluginFrame({ manifest, panel }: { manifest: Manifest; panel: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const w = ref.current?.contentWindow;
    if (!w) return;
    frames.set(w, { manifest, panel });
    return () => void frames.delete(w);
  }, [manifest, panel]);
  const name = localized(manifest.name, host?.locale ?? "en");
  return (
    <div className="dem-plugin">
      <div className="dem-plugin-name">
        <Icon name="plugin" size={12} />
        <span>{name}</span>
      </div>
      <iframe
        ref={ref}
        className="dem-plugin-page"
        title={name}
        sandbox="allow-scripts"
        src={pluginUrl(manifest.id, `index.html?panel=${encodeURIComponent(panel)}`)}
      />
    </div>
  );
}

function start(m: Manifest, h: Host): () => void {
  const undo: (() => void)[] = [];
  for (const p of m.panels ?? [])
    undo.push(
      registerPanel({
        id: panelId(m.id, p.id),
        icon: "plugin",
        render: () => <PluginFrame manifest={m} panel={p.id} />,
      }),
    );
  // The background page runs commands that open no panel.
  let background: HTMLIFrameElement | null = null;
  if ((m.commands ?? []).some((c) => !c.panel)) {
    background = document.createElement("iframe");
    background.hidden = true;
    background.sandbox.add("allow-scripts");
    background.title = localized(m.name, h.locale);
    background.src = pluginUrl(m.id, "index.html");
    document.body.append(background);
    const w = background.contentWindow;
    if (w) frames.set(w, { manifest: m, panel: null });
    undo.push(() => {
      if (w) frames.delete(w);
      background?.remove();
    });
  }
  for (const c of m.commands ?? [])
    undo.push(
      registerCommand({
        id: `plugin.${m.id}.${c.id}`,
        title: localized(c.title, h.locale),
        icon: "plugin",
        run: () => {
          if (c.panel) openPanel(m, c.panel);
          else if (background?.contentWindow)
            post(background.contentWindow, { event: "command", id: c.id });
        },
      }),
    );
  return () => undo.reverse().forEach((f) => f());
}

const restarts = new Set<() => void>();

/** Tells the running app that plugins were installed, enabled or turned off. */
export function pluginsChanged() {
  restarts.forEach((f) => f());
}

/** Starts the enabled external plugins; the returned function stops them all. */
export function startExternalPlugins(h: Host): () => void {
  host = h;
  let stops: (() => void)[] = [];
  let alive = true;
  const load = () => {
    stops.forEach((f) => f());
    stops = [];
    void api
      .pluginList()
      .then((list) => {
        if (!alive) return;
        for (const p of list)
          if (p.enabled && p.manifest) {
            try {
              stops.push(start(p.manifest, h));
            } catch (e) {
              console.error(p.folder, e);
            }
          }
      })
      .catch(() => undefined);
  };
  load();
  restarts.add(load);
  window.addEventListener("message", onMessage);
  const offChanged = onItemsChanged(() =>
    broadcast({ event: "changed" }, (f) => (f.manifest.permissions ?? []).includes("items:read")),
  );
  // Follow the theme: light and dark, the space's colours, the font size.
  let queued = false;
  const retheme = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (frames.size) broadcast({ event: "theme", tokens: tokens() });
    });
  };
  const watch = new MutationObserver(retheme);
  watch.observe(document.documentElement, { attributes: true });
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
  dark?.addEventListener("change", retheme);
  return () => {
    alive = false;
    restarts.delete(load);
    stops.forEach((f) => f());
    window.removeEventListener("message", onMessage);
    offChanged();
    watch.disconnect();
    dark?.removeEventListener("change", retheme);
    frames.clear();
    host = null;
  };
}
