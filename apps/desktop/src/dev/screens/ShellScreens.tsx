// Review page for P0.5-07-2 and 07-3, development builds only: #/screens/home (starts on the
// home page) and #/screens/shell (starts in the workspace). The real shell with demo panels and
// three spaces, each with its own layout. window.__ws exposes the workspace to the probe script.
// Query: ?space=<id> starts in that space; ?scene=none leaves the star map out; ?bloom=0;
// ?glass=css; ?perf runs the frame-time measurement on the home page (results in .perf/).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HOME_PANEL } from "../../shell/Shell";
import { useT } from "../../i18n/context";
import { Shell, type LayoutStore } from "../../shell/Shell";
import type { SidebarView } from "../../shell/LeftmostBar";
import { setAppearance, useAppearance } from "../../settings/appearance";
import { registerAiSection } from "../../settings/SettingsPanel";
import { commands } from "../../shell/commands";
import { spaceColors, type Space } from "../../shell/spaces";
import { StatusDetail, StatusDot } from "../../shell/StatusBar";
import { PrivacyMark } from "../../ui/Badge";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { Icon } from "../../ui/Icon";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import type { WorkspaceApi } from "../../workspace/api";
import type { Layout } from "../../workspace/layout";
import { panelDefinition, registerPanel, type PanelProps } from "../../workspace/registry";
import { DEFAULT_LAYOUT, NOTES } from "../demo";
import { demoGraph, demoWidgets } from "./homeDemo";
import { runHomePerf, type PerfSetup } from "./homePerf";
import { registerLauncherDemo } from "./launcherDemo";
import "../lab.css";

registerAiSection();

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
let perfStarted = false;
const LAUNCHER_PAGE = location.hash.startsWith("#/screens/launcher");
const SETTINGS_PAGE = location.hash.startsWith("#/screens/settings");
const START_IN_WORKSPACE =
  location.hash.startsWith("#/screens/shell") || LAUNCHER_PAGE || SETTINGS_PAGE;
/** The launcher review page: one button per kind of input (docs/05-design.md §4.2). */
const LAUNCHER_EXAMPLES = [
  "fy",
  "法语",
  ">切换",
  ">切换空间 求",
  "?这周法语学了什么",
  "?/",
  "+",
  "+记忆卡 le quai 站台",
  "+买火车票",
  "#学",
  "@法",
  "@法语 ?总结这周的错误",
];

// The sidebar's navigation panel shows whichever view the leftmost bar picked.
let navView = "tree";
const navListeners = new Set<() => void>();
const setNavView = (v: string) => {
  navView = v;
  navListeners.forEach((f) => f());
};
const subscribeNav = (f: () => void) => (navListeners.add(f), () => navListeners.delete(f));

// demo.tsx registered the directory as "tree"; the nav panel shows it for the 目录 view.
const Directory = panelDefinition("tree")?.render;
function Nav(props: PanelProps) {
  const view = useSyncExternalStore(subscribeNav, () => navView);
  if (view === "tree" && Directory) return <Directory {...props} />;
  return <p className="lab-quiet">{view}</p>;
}
registerPanel({ id: "nav", icon: "tree", role: "widget", render: Nav });

const navTab = {
  id: "nav",
  contentId: "nav",
  component: "nav",
  title: "目录",
  kind: "pin" as const,
};
const MAIN: Layout = {
  ...DEFAULT_LAYOUT,
  columns: DEFAULT_LAYOUT.columns.map((c, i) =>
    i === 0
      ? {
          ...c,
          cells: c.cells.map((x) => ({
            ...x,
            tabs: x.tabs.map((t) => (t === "tree" ? "nav" : t)),
          })),
        }
      : c,
  ),
  tabs: {
    ...DEFAULT_LAYOUT.tabs,
    nav: navTab,
    home: { id: "home", contentId: "home", component: HOME_PANEL, title: "首页", kind: "pin" },
  },
};
const homeTab = (space: string) => ({
  id: `home-${space}`,
  contentId: `home-${space}`,
  component: HOME_PANEL,
  title: "首页",
  kind: "pin" as const,
});
const FRENCH: Layout = {
  version: 1,
  columns: [
    { size: 0.26, cells: [{ size: 1, tabs: ["nav"] }] },
    {
      size: 0.74,
      cells: [{ size: 1, tabs: ["home-fr", "l11", "l12"], active: "l11" }],
    },
  ],
  floating: [],
  tabs: {
    "home-fr": homeTab("fr"),
    nav: navTab,
    l11: { id: "l11", contentId: "l11", component: "note", title: NOTES.l11 ?? "", kind: "pin" },
    l12: { id: "l12", contentId: "l12", component: "note", title: NOTES.l12 ?? "", kind: "temp" },
  },
};
const JOBS: Layout = {
  version: 1,
  columns: [{ size: 1, cells: [{ size: 1, tabs: ["home-job", "cv"], active: "cv" }] }],
  floating: [],
  tabs: {
    "home-job": homeTab("job"),
    cv: { id: "cv", contentId: "cv", component: "note", title: NOTES.cv ?? "", kind: "pin" },
  },
};

const SPACES: Space[] = [
  { id: "main", name: "主空间", color: 0 },
  { id: "fr", name: "法语", color: 1 },
  { id: "job", name: "求职", color: 2 },
];

function memoryStore(): LayoutStore {
  const saved = new Map<string, Layout>([
    ["main", MAIN],
    ["fr", FRENCH],
    ["job", JOBS],
  ]);
  return { load: (s) => saved.get(s) ?? JOBS, save: (s, l) => void saved.set(s, l) };
}

declare global {
  interface Window {
    __ws?: WorkspaceApi;
  }
}

function useActiveContent(ws: WorkspaceApi | null) {
  const [title, setTitle] = useState<string>();
  const [id, setId] = useState<string>();
  const [home, setHome] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const latestTitle = useRef<string | undefined>(undefined);
  // The last content tab with focus; clicking in 目录 keeps showing the note. After a space
  // switch the old note is gone, so fall back to the first one open.
  useEffect(() => {
    if (!ws) return;
    const sync = () => {
      const tabs = ws.tabs().filter((x) => x.component === "note" && NOTES[x.contentId]);
      const a =
        tabs.find((x) => x.isActive) ??
        tabs.find((x) => x.title === latestTitle.current) ??
        tabs[0];
      setHome(ws.tabs().some((x) => x.isActive && x.component === HOME_PANEL));
      // The demo's diary cluster is private: AI is greyed while one of its notes has focus.
      setPrivateOpen(ws.tabs().some((x) => x.isActive && x.contentId.startsWith("diary:")));
      latestTitle.current = a?.title;
      setTitle(a?.title);
      setId(a?.contentId);
    };
    const off = ws.subscribe(sync);
    sync();
    return off;
  }, [ws]);
  return { title, id, home, privateOpen };
}

function Page({
  space,
  setSpace,
  spaces,
  setSpaces,
  perf,
}: {
  space: string;
  setSpace: (s: string) => void;
  spaces: Space[];
  setSpaces: (s: Space[]) => void;
  perf: PerfSetup;
}) {
  const t = useT();
  const appearance = useAppearance();
  const [graph] = useState(demoGraph);
  const [ws, setWs] = useState<WorkspaceApi | null>(null);
  const [view, setView] = useState("tree");
  const [layouts] = useState(memoryStore);
  const active = useActiveContent(ws);
  const current = spaces.find((s) => s.id === space) ?? SPACES[0];
  const views: SidebarView[] = [
    { id: "tree", icon: "tree", label: t("shell.view.tree"), shortcut: "Mod+Shift+E" },
    { id: "search", icon: "search", label: t("shell.view.search"), shortcut: "Mod+Shift+F" },
    {
      id: "favorites",
      icon: "favorite",
      label: t("shell.view.favorites"),
      shortcut: "Mod+Shift+B",
    },
    { id: "calendar", icon: "calendar", label: t("shell.view.calendar"), shortcut: "Mod+Shift+C" },
  ];
  const stub = (what: string) => () => showToast({ text: `（开发版）${what}` });
  const spacesRef = useRef(spaces);
  useEffect(() => {
    spacesRef.current = spaces;
  });
  useEffect(
    () =>
      registerLauncherDemo(
        t,
        graph,
        () => spacesRef.current,
        () => window.__ws ?? null,
      ),
    [t, graph],
  );
  const [request, setRequest] = useState<{ text: string; seq: number } | undefined>(() =>
    params.has("launcher") ? { text: params.get("launcher") ?? "", seq: 1 } : undefined,
  );
  const running = ["第 12 课 Le passé composé：整理生词", "第三章草稿：查资料"];
  return (
    <>
      {LAUNCHER_PAGE && (
        <nav className="screen-launcher-examples" aria-label="例子">
          {LAUNCHER_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setRequest((r) => ({ text: ex, seq: (r?.seq ?? 0) + 1 }))}
            >
              {ex}
            </button>
          ))}
        </nav>
      )}
      <Shell
        launcherRequest={request}
        contentPrivacy={active.privateOpen ? "private" : "normal"}
        spaces={spaces}
        space={space}
        onSpace={setSpace}
        onNewSpace={() => {
          const n = spaces.length + 1;
          const s: Space = { id: `s${n}`, name: `空间 ${n}`, color: n % 3 };
          setSpaces([...spaces, s]);
          setSpace(s.id);
        }}
        views={views}
        view={view}
        onView={(v, floating) => {
          setView(v);
          setNavView(v);
          if (floating) return;
          const nav = ws?.tabs().find((x) => x.contentId === "nav");
          const label = views.find((x) => x.id === v)?.label;
          if (nav && label) {
            ws?.retitle(nav.id, label);
            ws?.activate(nav.id);
          }
        }}
        notifications={["第 12 课的复习到期了", "AI 提议修改《第三章草稿》的第二段"]}
        layouts={layouts}
        crumb={active.title}
        statusLeft={
          active.home
            ? []
            : [
                t("status.saved"),
                ...(active.id === "cv" ? [<PrivacyMark key="p" level="sensitive" />] : []),
                t("status.words", { n: active.id === "cv" ? 1260 : 842 }),
              ]
        }
        statusRight={[
          <StatusDetail
            key="ai"
            details={
              <ul>
                {running.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          >
            <Icon name="ai" size={12} />
            {t("status.aiRunning", { n: running.length })}
          </StatusDetail>,
          t("status.offline"),
          <span key="space" className="dem-statusbar-item">
            <StatusDot
              color={current ? spaceColors(current, appearance.scheme)[0] : "currentColor"}
            />
            {current?.name}
          </span>,
        ]}
        onSpaceColor={(id, color) =>
          setSpaces(spaces.map((x) => (x.id === id ? { ...x, color } : x)))
        }
        onReady={(api) => {
          if (START_IN_WORKSPACE) {
            const l12 = api.tabs().find((x) => x.contentId === "l12");
            if (l12) api.activate(l12.id);
          }
          window.__ws = api;
          setWs(api);
          // The settings review page opens 设置 the way ⌘, does.
          if (SETTINGS_PAGE)
            setTimeout(
              () =>
                commands()
                  .find((c) => c.id === "shell.settings")
                  ?.run(),
              0,
            );
        }}
        home={{
          graph: params.get("scene") === "none" ? undefined : graph,
          widgets: demoWidgets(t),
          bloom: perf.bloom,
          onAddWidget: stub("增删小组件在 P2 做（H4）"),
          onOpenNode: (node) =>
            ws?.open({
              contentId: node.id,
              title: node.title,
              component: "note",
            }),
        }}
        webglGlass={perf.webgl}
        renderView={(_, api) => (
          <Nav tabId="float" contentId="nav" kind="pin" params={{}} workspace={api} />
        )}
      />
      <ToastRegion />
    </>
  );
}

export function ShellScreens() {
  const appearance = useAppearance();
  const [spaces, setSpaces] = useState(SPACES);
  const [space, setSpace] = useState(() => {
    const s = params.get("space");
    return SPACES.some((x) => x.id === s) ? (s as string) : "main";
  });
  const current = spaces.find((s) => s.id === space) ?? SPACES[0];
  const [perf, setPerf] = useState<PerfSetup>({
    webgl: params.get("glass") !== "css",
    bloom: params.get("bloom") !== "0",
  });
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    // Once per page load: StrictMode runs effects twice in development.
    if (params.has("perf") && !perfStarted && (perfStarted = true))
      void runHomePerf(setPerf, Number(params.get("seconds")) || 10).then(setResult);
  }, []);
  return (
    <GlassProvider
      accent={current ? spaceColors(current, appearance.scheme)[0] : undefined}
      settings={appearance.glass}
      onSettingsChange={(glass) => setAppearance({ glass })}
    >
      <Page space={space} setSpace={setSpace} spaces={spaces} setSpaces={setSpaces} perf={perf} />
      {result && (
        <pre className="lab-result" data-testid="perf-result">
          {result}
        </pre>
      )}
    </GlassProvider>
  );
}
