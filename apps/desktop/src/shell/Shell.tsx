// The window skeleton (docs/05-design.md §2.1): title bar, leftmost bar, workspace, status bar
// and the AI button. Owns what belongs to the whole window: the current space's colours and
// wallpaper, each space's layout, folding columns in narrow windows and the shell shortcuts.
// The home page (§8) is each space's first tab; while it is in front the workspace steps aside
// for the star map and the home widgets, and sidebar views float out instead.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { HomeGrid, type HomeWidget, type WidgetPlace } from "../home/HomeGrid";
import { HomeHero } from "../home/HomeHero";
import type { StarGraph, StarNode } from "../home/starmap/graph";
import type { StarScene } from "../home/starmap/scene";
import { StarMap } from "../home/starmap/StarMap";
import { useT } from "../i18n/context";
import { useColorMode } from "../theme/mode.ts";
import { applyVars, spaceVars } from "../theme/runtime.ts";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { GlassBackdrop } from "../ui/glass/GlassBackdrop";
import { useWallpaper } from "../ui/glass/wallpaper";
import { Tooltip } from "../ui/Tooltip";
import type { WorkspaceApi } from "../workspace/api";
import type { Layout } from "../workspace/layout";
import { registerPanel } from "../workspace/registry";
import { Workspace, type TabArrangement } from "../workspace/Workspace";
import { AiButton } from "./AiButton";
import { useAiGate } from "../privacy/AiGate";
import type { AiSession } from "../privacy/policy";
import type { PrivacyLevel } from "../ui/Badge";
import { AskWindow } from "../launcher/AskWindow";
import { aiCommandSource, askSource } from "../launcher/builtins";
import { Launcher } from "../launcher/Launcher";
import { commandSource, registerSource } from "../launcher/sources";
import { setAppearance } from "../settings/appearance";
import { SettingsHostContext } from "../settings/context";
import { SettingsPanel } from "../settings/SettingsPanel";
import { currentMode } from "../theme/mode.ts";
import { registerCommand, shortcutOf, useCommandKeys, useCommandsVersion } from "./commands";
import { useColumnFolding, type Side } from "./folding";
import { LeftmostBar, type SidebarView } from "./LeftmostBar";
import { useAppearance } from "../settings/appearance";
import { spaceColors, type Space } from "./spaces";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import "./shell.css";

const TITLE_H = 44,
  STATUS_H = 28,
  LEFTMOST_W = 48,
  GUTTER = 7;

/** The home tab's panel. The shell draws the home page itself, so the panel shows nothing. */
export const HOME_PANEL = "home";
registerPanel({ id: HOME_PANEL, icon: "home", render: () => null });
/** 设置 is a workspace tab (2026-10-26). */
export const SETTINGS_PANEL = "settings";
registerPanel({ id: SETTINGS_PANEL, icon: "settings", render: SettingsPanel });

export interface HomeSetup {
  /** The star map's items; leave out for 首页场景：不显示 (the wallpaper stays). */
  graph?: StarGraph;
  widgets: HomeWidget[];
  bloom?: boolean;
  onOpenNode: (node: StarNode) => void;
  /** Shows 添加小组件 at the top right. */
  onAddWidget?: () => void;
  /** Takes that place when given: what edit mode offers. */
  actions?: ReactNode;
  editing?: boolean;
  onPlace?: (id: string, at: WidgetPlace) => void;
  onRemove?: (id: string) => void;
}

/** Where each space's layout lives; P1 keeps it in the library. */
export interface LayoutStore {
  load(space: string): Layout | undefined;
  save(space: string, layout: Layout): void;
}

export function Shell({
  spaces,
  space,
  onSpace,
  onNewSpace,
  views,
  view,
  onView,
  notifications,
  layouts,
  arrangement,
  crumb,
  statusLeft,
  statusRight,
  contentPrivacy = "normal",
  contentAiWeb = false,
  launcherRequest,
  onSpaceColor,
  onRenameSpace,
  onDeleteSpace,
  onReady,
  home,
  renderView,
  webglGlass = true,
  ai = true,
  onAsk,
}: {
  spaces: Space[];
  space: string;
  onSpace: (id: string) => void;
  onNewSpace: () => void;
  views: SidebarView[];
  view: string;
  /** `floating`: the view floats out on the home page instead of switching the sidebar. */
  onView: (id: string, floating: boolean) => void;
  notifications: ReactNode[];
  layouts: LayoutStore;
  arrangement?: TabArrangement;
  /** The current content's title, after the space name. */
  crumb?: string;
  statusLeft: ReactNode[];
  statusRight: ReactNode[];
  /** The current content's level: AI in the launcher follows it (§5.6). */
  contentPrivacy?: PrivacyLevel;
  /** The active content is marked 可以联网给 AI 用. */
  contentAiWeb?: boolean;
  /** Development review pages: opens the launcher with this text whenever seq changes. */
  launcherRequest?: { text: string; seq: number };
  /** Settings → 空间颜色: one of the scheme's colour sets, or a picked colour. */
  onSpaceColor: (id: string, color: number | string) => void;
  onRenameSpace?: (id: string, name: string) => void;
  onDeleteSpace?: (id: string) => void;
  onReady?: (ws: WorkspaceApi) => void;
  home: HomeSetup;
  /** What a sidebar view shows when it floats out on the home page. */
  renderView: (view: string, ws: WorkspaceApi) => ReactNode;
  /** Off forces CSS blur for the glass (performance comparison). */
  webglGlass?: boolean;
  /** Off until the AI gateway exists (P3): no AI button, nothing about AI in the launcher. */
  ai?: boolean;
  /** Takes questions from the launcher; review pages leave it out and show the sample window. */
  onAsk?: (question: string, scope: string | undefined, session: AiSession) => void;
}) {
  const t = useT();
  const mode = useColorMode();
  const current = spaces.find((s) => s.id === space) ?? spaces[0];
  const appearance = useAppearance();
  const colors = current ? spaceColors(current, appearance.scheme) : undefined;
  // 首页场景：不显示 leaves the wallpaper; the page may also leave the scene out itself.
  const graph = appearance.homeScene === "starmap" ? home.graph : undefined;
  const wallpaper = useWallpaper(mode, colors ?? []);
  useEffect(
    () => (colors ? applyVars(document.documentElement, spaceVars(mode, colors)) : undefined),
    [mode, colors],
  );

  const [ws, setWs] = useState<WorkspaceApi | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => innerWidth);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fold = useColumnFolding(ws, width);

  // Home mode follows the workspace: the home tab having focus is the home page.
  const [isHome, setIsHome] = useState(false);
  useEffect(() => {
    if (!ws) return;
    const sync = () => setIsHome(ws.tabs().some((x) => x.isActive && x.component === HOME_PANEL));
    const off = ws.subscribe(sync);
    sync();
    return off;
  }, [ws]);
  const goHome = () => {
    if (!ws) return;
    const tab = ws.tabs().find((x) => x.component === HOME_PANEL);
    if (tab) ws.activate(tab.id);
    else
      ws.open(
        { contentId: HOME_PANEL, title: t("shell.home"), component: HOME_PANEL },
        { kind: "pin" },
      );
  };

  // On the home page a sidebar view floats out of the leftmost bar; leaving home closes it.
  const [floating, setFloating] = useState<string | null>(null);
  const [wasHome, setWasHome] = useState(isHome);
  if (wasHome !== isHome) {
    setWasHome(isHome);
    setFloating(null);
  }
  const pickView = (id: string) => {
    if (isHome) setFloating((f) => (f === id ? null : id));
    else if (fold.folded.left) fold.toggle("left");
    onView(id, isHome);
  };
  const [homeEl, setHomeEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!floating || !homeEl) return;
    const close = (e: Event) => {
      // A click on the empty home page only closes the panel, it does not also open a star.
      if (e.type === "click" && e.target !== homeEl) return;
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setFloating(null);
    };
    homeEl.addEventListener("click", close, { capture: true });
    window.addEventListener("keydown", close);
    return () => {
      homeEl.removeEventListener("click", close, { capture: true });
      window.removeEventListener("keydown", close);
    };
  }, [floating, homeEl]);
  const [star, setStar] = useState<{ scene: StarScene; canvas: HTMLCanvasElement } | null>(null);
  const scene = isHome && graph ? star : null;

  // Each space keeps its own layout: save the one we leave, load the one we enter.
  const shown = useRef(space);
  useEffect(() => {
    if (!ws || shown.current === space) return;
    const from = spaces.findIndex((s) => s.id === shown.current),
      to = spaces.findIndex((s) => s.id === space);
    layouts.save(shown.current, ws.save());
    shown.current = space;
    const next = layouts.load(space);
    if (next) ws.load(next);
    slideIn(area.current, to < from ? -1 : 1);
  }, [ws, space, spaces, layouts]);

  const [notifyOpen, setNotifyOpen] = useState(false);
  // One launcher for everything (§4.1): ⌘K empty, ⌘N and the title bar's + with "+", the AI
  // button with "?". A question asked there opens a small AI window.
  const [launcher, setLauncher] = useState({ open: false, initial: "", session: 0 });
  const openLauncher = (initial = "") =>
    setLauncher((l) => ({ open: true, initial, session: l.session + 1 }));
  const [ask, setAsk] = useState<{
    question: string;
    scope?: string;
    session?: AiSession;
  } | null>(null);
  const aiGate = useAiGate(contentPrivacy, contentAiWeb);
  const gate = useRef(aiGate);
  const askRef = useRef(onAsk);
  useEffect(() => {
    askRef.current = onAsk;
  });
  useEffect(() => {
    gate.current = aiGate;
  });
  // A new request (seq) reopens it; adjusted while rendering, not in an effect.
  const [seenRequest, setSeenRequest] = useState<number | undefined>(undefined);
  if (launcherRequest && launcherRequest.seq !== seenRequest) {
    setSeenRequest(launcherRequest.seq);
    setLauncher((l) => ({ open: true, initial: launcherRequest.text, session: l.session + 1 }));
  }
  useEffect(() => {
    const offs = [registerSource(commandSource(t("launcher.group.commands")))];
    if (!ai) return () => offs.forEach((off) => off());
    offs.push(
      registerSource(
        askSource(t, (question, scope) =>
          gate.current.request((session) =>
            askRef.current
              ? askRef.current(question, scope, session)
              : setAsk({ question, scope, session }),
          ),
        ),
      ),
      registerSource(
        aiCommandSource(t, (cmd, arg) =>
          gate.current.request((session) => {
            const question = `${t(`launcher.ai.${cmd}`)}${arg ? ` ${arg}` : ""}`;
            if (askRef.current) askRef.current(question, undefined, session);
            else setAsk({ question, session });
          }),
        ),
      ),
    );
    return () => offs.forEach((off) => off());
  }, [t, ai]);
  const openSettings = () => {
    if (!ws) return;
    const tab = ws.tabs().find((x) => x.component === SETTINGS_PANEL);
    if (tab) ws.activate(tab.id);
    else
      ws.open({
        contentId: SETTINGS_PANEL,
        title: t("shell.settingsTab"),
        component: SETTINGS_PANEL,
      });
  };
  const latest = useRef({
    views,
    spaces,
    pickView,
    onSpace,
    openLauncher,
    openSettings,
    goHome,
    toggle: fold.toggle,
  });
  useEffect(() => {
    latest.current = {
      views,
      spaces,
      pickView,
      onSpace,
      openLauncher,
      openSettings,
      goHome,
      toggle: fold.toggle,
    };
  });
  useCommandsVersion();
  const viewKeys = views.map((v) => `${v.id}:${v.shortcut ?? ""}`).join();
  useEffect(() => {
    const L = () => latest.current;
    const offs = [
      ...L().views.map(
        (v) =>
          v.shortcut &&
          registerCommand({
            id: `shell.view.${v.id}`,
            title: v.label,
            shortcut: v.shortcut,
            icon: v.icon,
            group: "sidebar",
            run: () => L().pickView(v.id),
          }),
      ),
      registerCommand({
        id: "shell.notifications",
        title: t("shell.notifications"),
        shortcut: "Mod+Shift+N",
        icon: "notifications",
        group: "sidebar",
        run: () => setNotifyOpen((o) => !o),
      }),
      registerCommand({
        id: "shell.settings",
        title: t("shell.settings"),
        shortcut: "Mod+,",
        icon: "settings",
        run: () => L().openSettings(),
      }),
      // Changes a setting: offered in the launcher, never to AI (commandsForAi).
      registerCommand({
        id: "settings.toggleDark",
        title: t("settings.cmd.toggleDark"),
        icon: "moon",
        changesSettings: true,
        run: () => setAppearance({ mode: currentMode() === "dark" ? "light" : "dark" }),
      }),
      registerCommand({
        id: "shell.home",
        title: t("shell.home"),
        shortcut: "Mod+Shift+H",
        icon: "home",
        run: () => L().goHome(),
      }),
      registerCommand({
        id: "shell.launcher",
        title: t("shell.launcher"),
        shortcut: "Mod+K",
        icon: "command",
        hidden: true,
        run: () => L().openLauncher(),
      }),
      registerCommand({
        id: "shell.new",
        title: t("shell.newItem"),
        shortcut: "Mod+N",
        icon: "plus",
        run: () => L().openLauncher("+"),
      }),
      registerCommand({
        id: "shell.space",
        title: t("shell.switchSpaceTo"),
        icon: "spaces",
        group: "spaces",
        run: () => L().openLauncher(`>${t("shell.switchSpaceTo")} `),
        options: () => L().spaces.map((s) => ({ id: s.id, label: s.name })),
        runWith: (id) => L().onSpace(id),
      }),
      ...(["left", "right"] as Side[]).map((side) =>
        registerCommand({
          id: `shell.toggle.${side}`,
          title: t(side === "left" ? "shell.toggleLeft" : "shell.toggleRight"),
          shortcut: side === "left" ? "Mod+\\" : "Mod+Alt+\\",
          group: "workspace",
          run: () => L().toggle(side),
        }),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        registerCommand({
          id: `shell.space.${i + 1}`,
          title: t("shell.switchSpace", { n: i + 1 }),
          shortcut: `Mod+${i + 1}`,
          icon: "spaces",
          hidden: true,
          group: "spaces",
          run: () => {
            const s = L().spaces[i];
            if (s) L().onSpace(s.id);
          },
        }),
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [t, viewKeys]);
  useCommandKeys();

  return (
    <div
      className="dem-shell"
      style={{
        ["--shell-title-h" as string]: `${TITLE_H}px`,
        ["--shell-status-h" as string]: `${STATUS_H}px`,
        ["--shell-gutter" as string]: `${GUTTER}px`,
      }}
    >
      {graph && (
        <StarMap
          graph={graph}
          colors={colors ?? []}
          background={wallpaper}
          active={isHome}
          bloom={home.bloom}
          hitArea={homeEl}
          onScene={setStar}
          onOpen={home.onOpenNode}
        />
      )}
      <GlassBackdrop
        source={scene?.canvas ?? wallpaper}
        live={!!scene}
        // On the home page the star map draws the glass in its own WebGL context.
        sink={scene?.scene}
        accent={colors?.[0]}
        webgl={webglGlass}
      />
      <TitleBar>
        <span className="dem-crumb" data-tauri-drag-region>
          <span className="dem-crumb-space" data-tauri-drag-region>
            {current?.name}
          </span>
          {crumb && !isHome && (
            <span className="dem-crumb-item" data-tauri-drag-region>
              {crumb}
            </span>
          )}
        </span>
        <span className="dem-titlebar-gap" data-tauri-drag-region />
        <Tooltip label={t("shell.newItem")} shortcut={shortcutOf("shell.new")}>
          <Button
            variant="quiet"
            size="sm"
            icon="plus"
            aria-label={t("shell.newItem")}
            onPress={() => openLauncher("+")}
          />
        </Tooltip>
      </TitleBar>
      <SettingsHostContext.Provider
        value={{
          spaces,
          space,
          setSpaceColor: onSpaceColor,
          renameSpace: onRenameSpace,
          deleteSpace: spaces.length > 1 ? onDeleteSpace : undefined,
        }}
      >
        <div className="dem-shell-body">
          <LeftmostBar
            scheme={appearance.scheme}
            views={views}
            view={view}
            onView={pickView}
            floating={isHome ? floating : undefined}
            notifications={notifications}
            notificationsOpen={notifyOpen}
            onNotificationsOpen={setNotifyOpen}
            spaces={spaces}
            space={space}
            onSpace={onSpace}
            onHome={goHome}
            onNewSpace={onNewSpace}
            onSettings={() => latest.current.openSettings()}
          />
          <div className="dem-shell-area" ref={area}>
            <div className="dem-shell-ws" data-glass-hidden={isHome || undefined}>
              <Workspace
                arrangement={arrangement ?? appearance.tabs}
                onReady={(api) => {
                  const l = layouts.load(space);
                  if (l) api.load(l);
                  // The app opens on the home page.
                  const h = api.tabs().find((x) => x.component === HOME_PANEL);
                  if (h) api.activate(h.id);
                  setWs(api);
                  onReady?.(api);
                }}
              />
            </div>
            {isHome && ws && (
              <div className="dem-home" ref={setHomeEl}>
                <HomeHero
                  space={current?.name ?? ""}
                  actions={
                    home.actions ??
                    (home.onAddWidget && (
                      <Button size="sm" icon="plus" onPress={home.onAddWidget}>
                        {t("home.addWidget")}
                      </Button>
                    ))
                  }
                />
                <HomeGrid
                  widgets={home.widgets}
                  workspace={ws}
                  editing={home.editing}
                  onPlace={home.onPlace}
                  onRemove={home.onRemove}
                />
                {floating && (
                  // Over the header and widgets: the WebGL layer cannot draw those, so
                  // this one blurs with CSS (docs/05-design.md B.2).
                  <Glass
                    refract={false}
                    className="dem-home-float"
                    role="dialog"
                    aria-label={views.find((v) => v.id === floating)?.label}
                  >
                    <h2 className="dem-home-float-title">
                      {views.find((v) => v.id === floating)?.label}
                    </h2>
                    <div className="dem-home-float-body">{renderView(floating, ws)}</div>
                  </Glass>
                )}
              </div>
            )}
            {(["left", "right"] as Side[]).map(
              (side) =>
                !isHome &&
                fold.folded[side] && (
                  <button
                    key={side}
                    type="button"
                    className="dem-fold-edge"
                    data-side={side}
                    aria-label={t(side === "left" ? "shell.expandLeft" : "shell.expandRight")}
                    onClick={() => fold.toggle(side)}
                  />
                ),
            )}
          </div>
        </div>
      </SettingsHostContext.Provider>
      <StatusBar left={statusLeft} right={statusRight} />
      <Launcher
        isOpen={launcher.open}
        onOpenChange={(open) => setLauncher((l) => ({ ...l, open }))}
        initial={launcher.initial}
        session={launcher.session}
        privacy={contentPrivacy}
      />
      {aiGate.dialog}
      {ask && (
        <AskWindow
          question={ask.question}
          scope={ask.scope}
          session={ask.session}
          onClose={() => setAsk(null)}
        />
      )}
      {ai && (
        <AiButton
          onPress={() => openLauncher("?")}
          inset={{ top: TITLE_H, right: 0, bottom: STATUS_H, left: LEFTMOST_W + GUTTER * 2 }}
        />
      )}
    </div>
  );
}

/** A short slide in the direction of travel when switching spaces (none with reduced motion). */
function slideIn(el: HTMLElement | null, dir: 1 | -1) {
  if (!el) return;
  const css = getComputedStyle(document.documentElement);
  const duration = parseFloat(css.getPropertyValue("--dem-dur-slow")) || 0;
  if (!duration) return;
  el.animate(
    [
      { opacity: 0, transform: `translateX(${dir * 24}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration, easing: css.getPropertyValue("--dem-ease-spring").trim() || "ease-out" },
  );
}
