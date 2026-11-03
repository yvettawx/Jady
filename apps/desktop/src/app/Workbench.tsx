// The app once a library is open: the shell on real data. It owns the spaces and their layouts, what
// the launcher can find and the commands that belong to the whole library.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData } from "../bindings";
import { ProposalContext } from "../ai/context";
import { useLocale, useT } from "../i18n/context";
import { registerHomeWidget, useHomeWidgets } from "../home/registry";
import { contentSource, newSource, scopeSource, tagSource } from "../launcher/builtins";
import { registerSource } from "../launcher/sources";
import { registerPrivacyCommand } from "../privacy/commands";
import { registerSettingsSection } from "../settings/SettingsPanel";
import { setAppearance, useAppearance } from "../settings/appearance";
import type { SidebarView } from "../shell/LeftmostBar";
import { registerCommand } from "../shell/commands";
import { HOME_PANEL, Shell, type LayoutStore } from "../shell/Shell";
import { spaceColors, type Space } from "../shell/spaces";
import { StatusDot } from "../shell/StatusBar";
import { PrivacyMark } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { GlassProvider } from "../ui/glass/GlassProvider";
import { MenuButton } from "../ui/Menu";
import { TextField } from "../ui/TextField";
import { showToast } from "../ui/toast";
import type { WorkspaceApi } from "../workspace/api";
import type { Layout } from "../workspace/layout";
import { panelDefinition, registerPanel } from "../workspace/registry";
import {
  createAndOpen,
  failed,
  HEATMAP_PANEL,
  NAV_PANEL,
  newItem,
  NOTE_PANEL,
  openById,
  RECORDS_PANEL,
  TYPE_PANEL,
  VERSIONS_PANEL,
} from "./actions";
import { activeNoteId, flushNotes, setActiveNote, useActiveNote } from "./active";
import { api, itemsChanged, onItemsChanged } from "./api";
import { followAi, onProposal } from "./ai/chats";
import { createCoreProposalStore, loadRules } from "./ai/proposals";
import { loadFavorites } from "./favorites";
import { useLive } from "./live";
import { coreLevel, iconOf, levelOf, patch, titleOf, typeName } from "./model";
import { useHomeLayout } from "./homeLayout";
import { registerNavView, useNavViews } from "./navViews";
import { startPlugins } from "../plugins";
import { PluginsSection } from "../plugins/external/PluginsSection";
import { AiSettingsSection } from "./panels/AiSettingsSection";
import { AI_SEE_PANEL, AiSearchPreviewPanel } from "./panels/AiSearchPreview";
import { BrowserConfirm } from "./browser/BrowserConfirm";
import { BrowserSection } from "./browser/BrowserSection";
import {
  AiView,
  askInWindow,
  CHAT_PANEL,
  ChatPanel,
  ChatWindows,
  HARVEST_PANEL,
  HarvestPanel,
  PROPOSALS_PANEL,
  ProposalsPanel,
  ProposalsWidget,
} from "./panels/AiPanels";
import {
  LearnView,
  MASTERY_PANEL,
  MasteryPanel,
  MasteryWidget,
  PRACTICE_PANEL,
  PracticePanel,
  DERIVE_PANEL,
  DerivePanel,
  RECITE_PANEL,
  RecitePanel,
  REVIEW_PANEL,
  ReviewPanel,
  TALK_PANEL,
  TalkPanel,
} from "./panels/LearnPanels";
import { AnnotationsPanel, CharsPanel } from "./panels/SidePanelsExtra";
import { setSettingsWorkspace } from "./panels/settingsWorkspace";
import { DataSection } from "./panels/DataSection";
import {
  HeatPanel,
  HeatWidget,
  RemindersPanel,
  starGraph,
  TodosPanel,
  useReminders,
} from "./panels/HomePanels";
import { NavBody, NavPanel, setNavView } from "./panels/NavPanel";
import { NotePanel } from "./panels/NotePanel";
import { RecordsPanel } from "./panels/RecordsPanel";
import { WEEKLY_PANEL, WeeklyReviewPanel } from "./panels/ReviewView";
import { LinksPanel, OpenPanel, OutlinePanel } from "./panels/SidePanels";
import { TypePanel } from "./panels/TypePanel";
import { VersionsPanel } from "./panels/VersionsPanel";
import { notifyDue } from "./reminders";
import { library, refreshLibrary, followLibrary, useLibrary } from "./store";
import { lifeCommands, useLifeWidgets } from "./life/register";
import { Welcome } from "./life/Welcome";
import { useScheduledTasks } from "./life/Scheduled";
import "./app.css";

registerPanel({ id: NOTE_PANEL, icon: "file", render: NotePanel });
registerPanel({ id: NAV_PANEL, icon: "tree", role: "widget", render: NavPanel });
registerPanel({ id: "open", icon: "app-window", role: "widget", render: OpenPanel });
registerPanel({ id: "outline", icon: "outline", role: "widget", render: OutlinePanel });
registerPanel({ id: "links", icon: "link", role: "widget", render: LinksPanel });
registerPanel({ id: RECORDS_PANEL, icon: "kanban", render: RecordsPanel });
registerPanel({ id: TYPE_PANEL, icon: "edit", render: TypePanel });
registerPanel({ id: VERSIONS_PANEL, icon: "history", render: VersionsPanel });
registerPanel({ id: HEATMAP_PANEL, icon: "heatmap", role: "widget", render: HeatPanel });
registerPanel({ id: CHAT_PANEL, icon: "ai", render: ChatPanel });
registerPanel({ id: PROPOSALS_PANEL, icon: "proposal", render: ProposalsPanel });
registerPanel({ id: AI_SEE_PANEL, icon: "search", render: AiSearchPreviewPanel });
registerPanel({ id: HARVEST_PANEL, icon: "check", render: HarvestPanel });
registerPanel({ id: REVIEW_PANEL, icon: "card", render: ReviewPanel });
registerPanel({ id: TALK_PANEL, icon: "chat", render: TalkPanel });
registerPanel({ id: PRACTICE_PANEL, icon: "learn", render: PracticePanel });
registerPanel({ id: RECITE_PANEL, icon: "read", render: RecitePanel });
registerPanel({ id: DERIVE_PANEL, icon: "learn", render: DerivePanel });
registerPanel({ id: MASTERY_PANEL, icon: "mastery", role: "widget", render: MasteryPanel });
registerPanel({ id: "home-mastery", icon: "mastery", role: "widget", render: MasteryWidget });
registerPanel({ id: "home-proposals", icon: "proposal", role: "widget", render: ProposalsWidget });
registerPanel({ id: "annotations", icon: "edit", role: "widget", render: AnnotationsPanel });
registerPanel({ id: "chars", icon: "font", role: "widget", render: CharsPanel });
registerNavView({
  id: "learn",
  icon: "learn",
  label: "shell.view.learn",
  shortcut: "Mod+Shift+R",
  render: LearnView,
});
registerNavView({
  id: "ai",
  icon: "ai",
  label: "shell.view.ai",
  shortcut: "Mod+Shift+A",
  render: AiView,
});
registerSettingsSection({ id: "ai", icon: "ai", Body: AiSettingsSection });
registerSettingsSection({ id: "browser", icon: "web", Body: BrowserSection });
registerSettingsSection({ id: "plugins", icon: "plugin", Body: PluginsSection });
registerPanel({ id: WEEKLY_PANEL, icon: "review", render: WeeklyReviewPanel });
registerPanel({ id: "home-todos", icon: "todo", role: "widget", render: TodosPanel });
registerPanel({
  id: "home-reminders",
  icon: "notifications",
  role: "widget",
  render: RemindersPanel,
});
registerPanel({ id: "home-heatmap", icon: "heatmap", role: "widget", render: HeatWidget });
registerSettingsSection({ id: "library", icon: "folder", Body: DataSection });

/** Titles are messages, looked up when drawn. */
const BUILT_IN_WIDGETS = [
  { id: "todo", panel: "home-todos", title: "home.todos", col: 0, row: 0, w: 3, h: 3 },
  { id: "rem", panel: "home-reminders", title: "home.reminders", col: 0, row: 3, w: 3, h: 2 },
  { id: "heat", panel: "home-heatmap", title: "home.heatmap", col: 9, row: 3, w: 3, h: 2 },
  { id: "prop", panel: "home-proposals", title: "home.proposals", col: 9, row: 0, w: 3, h: 2 },
  { id: "mastery", panel: "home-mastery", title: "learn.mastery", col: 9, row: 2, w: 3, h: 1 },
];
BUILT_IN_WIDGETS.forEach(registerHomeWidget);

const NAMED_KEY = "ui-named-layouts";
const SPACES_KEY = "ui-spaces";
const SPACE_KEY = "ui-space";
const layoutKey = (space: string) => `ui-layout-${space}`;

function defaultLayout(t: (k: string) => string, space: string): Layout {
  const home = `home-${space}`;
  const tab = (id: string, component: string, title: string) => ({
    id,
    contentId: id,
    component,
    title,
    kind: "pin" as const,
  });
  return {
    version: 1,
    columns: [
      {
        size: 0.22,
        cells: [
          { size: 0.3, tabs: ["open"] },
          { size: 0.7, tabs: [NAV_PANEL] },
        ],
      },
      { size: 0.58, cells: [{ size: 1, tabs: [home] }] },
      {
        size: 0.2,
        cells: [
          { size: 0.55, tabs: ["outline", "annotations", "chars"] },
          { size: 0.45, tabs: ["links"] },
        ],
      },
    ],
    floating: [],
    tabs: {
      open: tab("open", "open", t("panel.open")),
      [NAV_PANEL]: tab(NAV_PANEL, NAV_PANEL, t("shell.view.tree")),
      [home]: tab(home, HOME_PANEL, t("shell.home")),
      outline: tab("outline", "outline", t("panel.outline")),
      annotations: tab("annotations", "annotations", t("panel.annotations")),
      chars: tab("chars", "chars", t("panel.chars")),
      links: tab("links", "links", t("panel.links")),
    },
  };
}

/** A 机密 item's title never goes into a saved layout. */
function safeLayout(t: (k: string) => string, layout: Layout): Layout {
  const tabs = Object.fromEntries(
    Object.entries(layout.tabs).map(([id, tab]) => [
      id,
      tab.params?.privacy === "secret" ? { ...tab, title: t("privacy.secretTitle") } : tab,
    ]),
  );
  return { ...layout, tabs };
}

interface Loaded {
  spaces: Space[];
  space: string;
  layouts: Map<string, Layout>;
}

async function loadUi(t: (k: string) => string): Promise<Loaded> {
  const parse = <T,>(json: string | null, fallback: T): T => {
    try {
      return json ? (JSON.parse(json) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const spaces = parse<Space[]>(await api.localGet(SPACES_KEY), [
    { id: "main", name: t("space.default"), color: 0 },
  ]);
  const saved = await api.localGet(SPACE_KEY);
  const space = spaces.some((s) => s.id === saved) ? (saved as string) : (spaces[0]?.id ?? "main");
  const layouts = new Map<string, Layout>();
  for (const s of spaces) {
    const l = parse<Layout | null>(await api.localGet(layoutKey(s.id)), null);
    if (l) layouts.set(s.id, l);
  }
  await Promise.all([refreshLibrary(), loadFavorites()]);
  return { spaces, space, layouts };
}

function NameDialog({
  title,
  label,
  confirm,
  onClose,
  onDone,
}: {
  title: string;
  label: string;
  confirm: string;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const done = () => {
    if (name.trim()) onDone(name.trim());
  };
  return (
    <Dialog title={title} isOpen onOpenChange={(o) => !o && onClose()}>
      <TextField
        aria-label={label}
        placeholder={label}
        autoFocus
        value={name}
        onChange={setName}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && done()}
      />
      <div className="dem-dialog-actions">
        <Button variant="primary" isDisabled={!name.trim()} onPress={done}>
          {confirm}
        </Button>
      </div>
    </Dialog>
  );
}

function NewSpaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const t = useT();
  return (
    <NameDialog
      title={t("space.new")}
      label={t("space.name")}
      confirm={t("space.create")}
      onClose={onClose}
      onDone={onCreate}
    />
  );
}

function Bench({ loaded, onLock }: { loaded: Loaded; onLock: () => void }) {
  const t = useT();
  const appearance = useAppearance();
  const [spaces, setSpaces] = useState(loaded.spaces);
  const [space, setSpace] = useState(loaded.space);
  const [ws, setWs] = useState<WorkspaceApi | null>(null);
  const [view, setView] = useState("tree");
  const [newSpace, setNewSpace] = useState(false);
  const [namingLayout, setNamingLayout] = useState(false);
  const namedRef = useRef<Record<string, Layout>>({});
  useEffect(() => {
    void api.localGet(NAMED_KEY).then((raw) => {
      try {
        namedRef.current = raw ? (JSON.parse(raw) as Record<string, Layout>) : {};
      } catch {
        namedRef.current = {};
      }
    });
  }, []);
  const note = useActiveNote();
  const lib = useLibrary();
  const wsRef = useRef(ws);
  useEffect(() => {
    wsRef.current = ws;
  });
  const current = spaces.find((s) => s.id === space) ?? spaces[0];

  const navs = useNavViews();
  const views: SidebarView[] = navs.map((v) => ({
    id: v.id,
    icon: v.icon,
    label: t(v.label),
    shortcut: v.shortcut,
  }));

  // Layouts: saved a moment after the arrangement stops changing, and whenever a space is left.
  const layouts = useMemo<LayoutStore>(
    () => ({
      load: (s) => loaded.layouts.get(s) ?? defaultLayout(t, s),
      save: (s, l) => {
        const safe = safeLayout(t, l);
        loaded.layouts.set(s, safe);
        void api.localSet(layoutKey(s), JSON.stringify(safe));
      },
    }),
    [loaded, t],
  );
  const spaceRef = useRef(space);
  useEffect(() => {
    spaceRef.current = space;
    void api.localSet(SPACE_KEY, space);
  }, [space]);
  useEffect(() => {
    void api.localSet(SPACES_KEY, JSON.stringify(spaces));
  }, [spaces]);
  useEffect(() => {
    if (!ws) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      const tabs = ws.tabs();
      const front = tabs.find((x) => x.isActive);
      // Clicking in a side panel keeps showing the note you came from; anything else in front
      // (a table, settings, the home page) has no note.
      if (front?.component === NOTE_PANEL) setActiveNote(front.contentId);
      else if (front && panelDefinition(front.component)?.role !== "widget") setActiveNote(null);
      else if (activeNoteId() && !tabs.some((x) => x.contentId === activeNoteId()))
        setActiveNote(null);
      clearTimeout(timer);
      timer = setTimeout(() => layouts.save(spaceRef.current, ws.save()), 800);
    };
    const off = ws.subscribe(sync);
    sync();
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [ws, layouts]);

  // What the launcher finds, always the current copy.
  useEffect(() => {
    const entries = () => {
      const { items, tree } = library();
      const names = new Map(tree.map((n) => [n.id, n.title ?? ""]));
      return items.map((i) => ({
        id: i.id,
        title: titleOf(t, i),
        path: i.container ? (names.get(i.container) ?? "") : "",
        icon: iconOf(i.typeId),
        tags: i.tags,
        privacy: levelOf(i.privacy),
        recent: i.updated ?? 0,
      }));
    };
    const offs = [
      registerSource(
        contentSource(t, entries, (e, how) => {
          const w = wsRef.current;
          if (!w) return;
          openById(
            w,
            t,
            e.id,
            how === "split"
              ? { split: "right", kind: "temp" }
              : how === "tab"
                ? { kind: "temp", newTab: true }
                : { kind: "temp" },
          );
        }),
      ),
      registerSource(tagSource(t, entries)),
      registerSource(
        scopeSource(t, () =>
          library().tree.map((n) => ({
            id: n.id,
            name: n.title ?? "",
            kind: n.kind === "domain" ? ("area" as const) : ("project" as const),
          })),
        ),
      ),
      registerSource(
        newSource(
          t,
          () =>
            library()
              .types.filter((x) => x.id !== "file")
              .map((x) => ({ id: x.id, name: typeName(t, x), icon: iconOf(x.id) })),
          (type, text) => {
            const w = wsRef.current;
            if (type && w) {
              void createAndOpen(w, t, { typeId: type.id, title: text }).catch(
                failed(t, t("shell.newItem")),
              );
            } else {
              void api
                .itemCreate(newItem({ typeId: "note", title: text, state: "inbox" }))
                .then(() => {
                  itemsChanged();
                  showToast({ text: t("capture.done") });
                })
                .catch(failed(t, t("shell.newItem")));
            }
          },
        ),
      ),
      registerPrivacyCommand(
        t,
        () => showToast({ text: t("privacy.pickHint") }),
        (level) => {
          const id = activeNoteId();
          if (!id) return showToast({ text: t("privacy.noNote") });
          const was = library().items.find((x) => x.id === id);
          // Lowering asks first, and only the picker on the page can do that.
          if (!was || coreLevel(level) === was.privacy) return;
          const ranks = ["normal", "sensitive", "private", "confidential"];
          if (ranks.indexOf(coreLevel(level)) < ranks.indexOf(was.privacy))
            return showToast({ text: t("privacy.pickHint") });
          void api
            .itemUpdate(id, patch({ privacy: coreLevel(level) }))
            .then(() => itemsChanged())
            .catch(failed(t, t("privacy.level")));
        },
      ),
      registerCommand({
        id: "capture.screenshot",
        title: t("capture.screenshot"),
        icon: "image",
        run: () =>
          void api
            .captureScreenshot(t("capture.screenshotTitle"))
            .then((made) => {
              if (!made) return;
              itemsChanged();
              showToast({ text: t("capture.done") });
            })
            .catch(failed(t, t("capture.screenshot"))),
      }),
      registerCommand({
        id: "layout.save",
        title: t("layout.save"),
        icon: "dock",
        run: () => setNamingLayout(true),
      }),
      registerCommand({
        id: "layout.use",
        title: t("layout.use"),
        icon: "dock",
        run: () => undefined,
        options: () => Object.keys(namedRef.current).map((n) => ({ id: n, label: n })),
        runWith: (name) => {
          const l = namedRef.current[name];
          if (l) wsRef.current?.load(l);
        },
      }),
      registerCommand({
        id: "library.lock",
        title: t("library.lock"),
        shortcut: "Mod+Shift+L",
        icon: "lock",
        run: () => onLock(),
      }),
      registerCommand({
        id: "ai.see",
        title: t("aiSee.title"),
        icon: "search",
        run: () =>
          wsRef.current?.open({
            contentId: AI_SEE_PANEL,
            component: AI_SEE_PANEL,
            title: t("aiSee.title"),
          }),
      }),
      registerCommand({
        id: "app.heatmap",
        title: t("heatmap.title"),
        icon: "heatmap",
        run: () =>
          wsRef.current?.open({
            contentId: HEATMAP_PANEL,
            component: HEATMAP_PANEL,
            title: t("heatmap.title"),
          }),
      }),
    ];
    offs.push(...lifeCommands(t, () => wsRef.current));
    return () => offs.forEach((off) => off());
  }, [t, onLock]);

  useScheduledTasks();
  useLifeWidgets(useLibrary().types.some((d) => d.id === "habit"));

  // Reminders: the bell, and one system notification a day for what is due.
  const { data: reminders } = useReminders();
  useEffect(() => {
    notifyDue(reminders, t);
  }, [reminders, t]);

  const { data: graph } = useLive<GraphData | null>(() => api.graphData(), null);
  const star = useMemo(
    () => (graph && graph.items.length ? starGraph(t, graph, lib.tree) : undefined),
    [graph, lib.tree, t],
  );

  // Stores for what AI proposes: one, whichever place shows a proposal.
  const proposals = useMemo(() => createCoreProposalStore(t), [t]);
  useEffect(() => {
    void loadRules();
    followAi();
    void proposals.refresh();
    const off = onProposal(() => void proposals.refresh());
    const offItems = onItemsChanged(() => void proposals.refresh());
    return () => {
      off();
      offItems();
    };
  }, [proposals]);
  useEffect(() => {
    setSettingsWorkspace(ws);
    return () => setSettingsWorkspace(null);
  }, [ws]);
  const widgets = useHomeWidgets();
  const home = useHomeLayout(space, widgets);
  // Plugins come up with the library and go away when it locks.
  const locale = useLocale();
  useEffect(() => startPlugins({ t, locale, workspace: () => wsRef.current }), [t, locale]);

  return (
    <GlassProvider
      accent={current ? spaceColors(current, appearance.scheme)[0] : undefined}
      settings={appearance.glass}
      onSettingsChange={(glass) => setAppearance({ glass })}
    >
      <ProposalContext.Provider value={proposals}>
        <Shell
          onAsk={(question, _scope, session) =>
            void askInWindow(
              {
                session,
                mode: "chat",
                title: question.slice(0, 30),
                tabContent: note?.id,
                container: lib.items.find((i) => i.id === note?.id)?.container ?? null,
              },
              question,
            ).catch(failed(t, t("menu.askAi")))
          }
          spaces={spaces}
          space={space}
          onSpace={setSpace}
          onNewSpace={() => setNewSpace(true)}
          views={views}
          view={view}
          onView={(v, floating) => {
            setView(v);
            setNavView(v);
            if (floating) return;
            const nav = ws?.tabs().find((x) => x.contentId === NAV_PANEL);
            const label = views.find((x) => x.id === v)?.label;
            if (nav && label) {
              ws?.retitle(nav.id, label);
              ws?.activate(nav.id);
            }
          }}
          notifications={reminders.map((r) => r.title || t("item.untitled"))}
          layouts={layouts}
          crumb={note?.title}
          contentPrivacy={note?.privacy ?? "normal"}
          contentAiWeb={note?.aiWeb ?? false}
          statusLeft={
            note
              ? [
                  t(note.saving ? "status.saving" : "status.saved"),
                  ...(note.privacy !== "normal"
                    ? [<PrivacyMark key="p" level={note.privacy} />]
                    : []),
                  t("status.words", { n: note.words }),
                ]
              : []
          }
          statusRight={[
            <span key="space" className="dem-statusbar-item">
              <StatusDot
                color={current ? spaceColors(current, appearance.scheme)[0] : "currentColor"}
              />
              {current?.name}
            </span>,
          ]}
          onSpaceColor={(id, color) =>
            setSpaces((all) => all.map((x) => (x.id === id ? { ...x, color } : x)))
          }
          onRenameSpace={(id, name) =>
            setSpaces((all) => all.map((x) => (x.id === id ? { ...x, name } : x)))
          }
          onDeleteSpace={(id) => {
            const rest = spaces.filter((x) => x.id !== id);
            const next = rest[0];
            if (!next) return;
            loaded.layouts.delete(id);
            if (space === id) setSpace(next.id);
            setSpaces(rest);
          }}
          onReady={setWs}
          home={{
            graph: star,
            widgets: home.placed.map((w) => ({ ...w, title: w.title && t(w.title) })),
            editing: home.editing,
            onPlace: home.place,
            onRemove: home.remove,
            actions: home.editing ? (
              <>
                {home.hidden.length > 0 && (
                  <MenuButton
                    label={t("home.addWidget")}
                    icon="plus"
                    items={home.hidden.map((w) => ({ id: w.id, label: t(w.title ?? w.id) }))}
                    onAction={(k) => home.add(String(k))}
                  />
                )}
                <Button size="sm" variant="primary" onPress={() => home.setEditing(false)}>
                  {t("home.editDone")}
                </Button>
              </>
            ) : (
              <Button size="sm" icon="edit" onPress={() => home.setEditing(true)}>
                {t("home.edit")}
              </Button>
            ),
            onOpenNode: (node) => ws && openById(ws, t, node.id, { kind: "temp" }),
          }}
          renderView={(v, api2) => <NavBody view={v} workspace={api2} />}
        />
        <ChatWindows workspace={ws} />
      </ProposalContext.Provider>
      {namingLayout && (
        <NameDialog
          title={t("layout.save")}
          label={t("layout.name")}
          confirm={t("action.save")}
          onClose={() => setNamingLayout(false)}
          onDone={(name) => {
            if (!ws) return;
            const next = { ...namedRef.current, [name]: safeLayout(t, ws.save()) };
            namedRef.current = next;
            void api.localSet(NAMED_KEY, JSON.stringify(next));
            setNamingLayout(false);
          }}
        />
      )}
      {newSpace && (
        <NewSpaceDialog
          onClose={() => setNewSpace(false)}
          onCreate={(name) => {
            const s: Space = {
              id: `s${Date.now().toString(36)}`,
              name,
              color: spaces.length % 3,
            };
            setSpaces([...spaces, s]);
            setSpace(s.id);
            setNewSpace(false);
          }}
        />
      )}
      <Welcome />
      <BrowserConfirm />
    </GlassProvider>
  );
}

export function Workbench({ onLock }: { onLock: () => void }) {
  const t = useT();
  // Loaded once: the copy follows changes by itself from then on.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    void loadUi(t).then(
      (l) => alive && setLoaded(l),
      (e: Error) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
    // Once per opening; the language only names the defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => followLibrary(failed(t, t("app.name"))), [t]);

  // Closing the window: what is still being typed gets saved first (M2, no data lost).
  useEffect(() => {
    const win = getCurrentWindow();
    const closing = win.onCloseRequested(() => flushNotes());
    return () => void closing.then((f) => f());
  }, []);

  if (error) return <p className="dem-app-error">{error.message}</p>;
  if (!loaded) return null;
  return <Bench loaded={loaded} onLock={onLock} />;
}
