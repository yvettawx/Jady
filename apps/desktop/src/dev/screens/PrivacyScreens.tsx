// Review page for P0.5-07-9, development builds only: #/screens/privacy
// The real shell with one note per privacy level and a sample AI answer. The verifier is a
// stand-in: window.__systemVerify picks what the system says (ok, failed, unavailable), and the
// master password is "correct horse". P1 connects the real thing through the core.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NoteSheet } from "../../editor/NoteSheet";
import type { SheetMode } from "../../editor/mode";
import { SelectionBar } from "../../editor/SelectionBar";
import { TextMenu, type TextAction } from "../../editor/TextMenu";
import { WikiLink, type LinkTarget } from "../../editor/WikiLink";
import { useT } from "../../i18n/context";
import { contentSource, type ContentEntry } from "../../launcher/builtins";
import { registerSource } from "../../launcher/sources";
import { useAiGate } from "../../privacy/AiGate";
import { registerPrivacyCommand } from "../../privacy/commands";
import { aiLink, verifiesByDefault } from "../../privacy/policy";
import { PrivacyPicker } from "../../privacy/PrivacyPicker";
import { ProtectedLink } from "../../privacy/ProtectedLink";
import { SecretGate, type SecretVerifier } from "../../privacy/SecretGate";
import { setAppearance, useAppearance } from "../../settings/appearance";
import { Shell, HOME_PANEL, type LayoutStore } from "../../shell/Shell";
import { spaceColors, type Space } from "../../shell/spaces";
import { PrivacyMark, type PrivacyLevel } from "../../ui/Badge";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { Tree } from "../../ui/Tree";
import type { WorkspaceApi } from "../../workspace/api";
import type { Layout, SavedTab } from "../../workspace/layout";
import { OpenList } from "../../workspace/OpenList";
import { registerPanel, type PanelProps } from "../../workspace/registry";
import "../lab.css";

declare global {
  interface Window {
    __ws?: WorkspaceApi;
    __systemVerify?: "ok" | "failed" | "unavailable";
  }
}

interface DemoNote {
  id: string;
  title: string;
  kind: string;
  no: string;
  text: string;
  level: PrivacyLevel;
}

const NOTES: DemoNote[] = [
  {
    id: "lesson",
    title: "第 12 课 Le passé composé",
    kind: "笔记",
    no: "0142",
    level: "normal",
    text: "复合过去时用来讲已经完成的动作，由助动词加过去分词组成。",
  },
  {
    id: "resume",
    title: "投递资料",
    kind: "笔记",
    no: "0178",
    level: "sensitive",
    text: "实习 A 下周一再问。期望薪资和推荐人的联系方式都放在这里。",
  },
  {
    id: "diary",
    title: "10月17日",
    kind: "日记",
    no: "0217",
    level: "private",
    text: "今天去了里昂。火车晚点四十分钟，在站台上和一位老太太聊了半天。",
  },
  {
    id: "papers",
    title: "证件和保单号",
    kind: "笔记",
    no: "0301",
    level: "secret",
    text: "护照和保单的号码都记在这一篇（示例内容）。",
  },
];

// The levels live here on this page; P1 reads and writes them through the core.
const levels = new Map(NOTES.map((n) => [n.id, n.level]));
const verifyOn = new Map(NOTES.map((n) => [n.id, verifiesByDefault(n.level)]));
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};
const subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
const useStore = () => useSyncExternalStore(subscribe, () => version);
const levelOf = (id: string): PrivacyLevel => levels.get(id) ?? "normal";

const verifier: SecretVerifier = {
  system: async () => {
    await new Promise((r) => setTimeout(r, 400));
    return window.__systemVerify ?? "ok";
  },
  password: async (pw) => {
    await new Promise((r) => setTimeout(r, 300));
    return pw === "correct horse" ? "ok" : "wrong";
  },
};

const resolve = (id: string): LinkTarget | null => {
  const n = NOTES.find((x) => x.id === id);
  return n ? { title: n.title, body: n.text, privacy: levelOf(n.id) } : null;
};
const openNote = (ws: WorkspaceApi, id: string) => {
  const tab = ws.tabs().find((x) => x.contentId === id);
  if (tab) return ws.activate(tab.id);
  const n = NOTES.find((x) => x.id === id);
  if (n)
    ws.open({
      contentId: id,
      title: levelOf(id) === "secret" ? "机密内容" : n.title,
      component: "privacy-note",
      params: { privacy: levelOf(id) },
    });
};

function NotePanel({ contentId, tabId, workspace }: PanelProps) {
  const t = useT();
  useStore();
  const note = NOTES.find((n) => n.id === contentId);
  const level = levelOf(contentId);
  const verify = verifyOn.get(contentId) ?? false;
  const [verified, setVerified] = useState(false);
  const [mode, setMode] = useState<SheetMode>("edit");
  const prose = useRef<HTMLDivElement>(null);
  const gate = useAiGate(level);
  const locked = level === "secret" && verify && !verified;
  const title = note?.title ?? "";
  // The tab says 机密内容 until verified, and carries the level for its lock.
  useEffect(() => {
    workspace.retitle(tabId, locked ? t("privacy.secretTitle") : title);
    workspace.setTabParams(tabId, { privacy: level });
  }, [workspace, tabId, locked, title, level, t]);
  if (!note) return null;
  if (locked) return <SecretGate verifier={verifier} onVerified={() => setVerified(true)} />;

  const askAi = () =>
    gate.request((session) =>
      showToast({
        text:
          session === "authorized" ? "（开发版）授权对话已开，不上网" : "（开发版）打开 AI 对话",
      }),
    );
  const onText = (a: TextAction | "ask-ai") => {
    if (a === "ask-ai") askAi();
    else if (a === "web-search") showToast({ text: "（开发版）打开搜索" });
    else showToast({ text: `（开发版）${t(`menu.${a === "card" ? "toCard" : a}`)}` });
  };
  return (
    <>
      <NoteSheet
        number={note.no}
        kind={note.kind}
        date="10月24日"
        title={note.title}
        mode={mode}
        onMode={setMode}
        onFormat={() => {}}
        privacy={level}
        onAi={askAi}
        meta={
          <PrivacyPicker
            level={level}
            verify={verify}
            onLevel={(l) => {
              levels.set(contentId, l);
              // Becoming 机密 turns verification on, and this tab has just proved nothing.
              if (l === "secret") {
                verifyOn.set(contentId, true);
                setVerified(false);
              }
              changed();
            }}
            onVerify={(on) => {
              verifyOn.set(contentId, on);
              changed();
            }}
          />
        }
      >
        <TextMenu privacy={level} onAction={onText}>
          <div
            ref={prose}
            className="dem-prose"
            data-mode={mode}
            contentEditable={mode === "edit"}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline
            aria-label="正文"
          >
            <p>{note.text}</p>
            <p>
              相关：
              {NOTES.filter((n) => n.id !== contentId).map((n) => (
                <span key={n.id}>
                  <WikiLink
                    target={n.id}
                    resolve={resolve}
                    onOpen={(id) => openNote(workspace, id)}
                    onCreate={() => {}}
                  />{" "}
                </span>
              ))}
            </p>
          </div>
        </TextMenu>
      </NoteSheet>
      <SelectionBar
        root={prose}
        disabled={mode === "read"}
        privacy={level}
        onAction={(a) => {
          if (a === "ask-ai") askAi();
          else if (a === "card") onText("card");
        }}
      />
      {gate.dialog}
    </>
  );
}

/** A sample AI answer: everything in it has gone through aiLink, as the gateway's output does. */
function AiSamplePanel({ workspace }: PanelProps) {
  useStore();
  const part = (id: string) => {
    const n = NOTES.find((x) => x.id === id);
    const link = aiLink(n ? { id: n.id, title: n.title, level: levelOf(n.id) } : null);
    return link.kind === "protected" ? (
      <ProtectedLink />
    ) : (
      <a
        className="dem-wikilink"
        href={`#item:${link.id}`}
        onClick={(e) => {
          e.preventDefault();
          openNote(workspace, link.id);
        }}
      >
        {link.title}
      </a>
    );
  };
  return (
    <div className="dem-sheet">
      <div className="dem-sheet-body">
        <div className="dem-sheet-page">
          <div className="dem-prose" data-testid="ai-answer">
            <p>
              这周你复习了 {part("lesson")}。还有几篇相关的内容我不能读：{part("resume")}、
              {part("diary")}、{part("papers")}，以及一篇已经不存在的 {part("gone")}。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function NavPanel({ workspace }: PanelProps) {
  useStore();
  return (
    <Tree
      aria-label="目录"
      onAction={(id) => openNote(workspace, String(id))}
      items={NOTES.map((n) => ({
        id: n.id,
        // 目录 is the one place a 机密 title shows (2026-11-02).
        label: n.title,
        icon: "file",
        trailing: <PrivacyMark level={levelOf(n.id)} />,
      }))}
    />
  );
}

registerPanel({ id: "privacy-note", icon: "file", render: NotePanel });
registerPanel({ id: "privacy-ai", icon: "ai", render: AiSamplePanel });
registerPanel({ id: "privacy-nav", icon: "tree", role: "widget", render: NavPanel });
registerPanel({
  id: "privacy-open",
  icon: "app-window",
  role: "widget",
  render: ({ workspace }) => <OpenList workspace={workspace} />,
});

const tab = (id: string, component: string, title: string, level?: PrivacyLevel): SavedTab => ({
  id,
  contentId: id,
  component,
  title,
  kind: "temp",
  params: level ? { privacy: level } : undefined,
});
const LAYOUT: Layout = {
  version: 1,
  columns: [
    {
      size: 0.24,
      cells: [
        { size: 0.45, tabs: ["open"] },
        { size: 0.55, tabs: ["nav"] },
      ],
    },
    {
      size: 0.76,
      cells: [{ size: 1, tabs: ["home", ...NOTES.map((n) => n.id), "ai"], active: "lesson" }],
    },
  ],
  floating: [],
  tabs: {
    open: { ...tab("open", "privacy-open", "打开的内容"), kind: "pin" },
    nav: { ...tab("nav", "privacy-nav", "目录"), kind: "pin" },
    home: { ...tab("home", HOME_PANEL, "首页"), kind: "pin" },
    ai: tab("ai", "privacy-ai", "AI 回答样例"),
    ...Object.fromEntries(
      NOTES.map((n) => [
        n.id,
        tab(n.id, "privacy-note", n.level === "secret" ? "机密内容" : n.title, n.level),
      ]),
    ),
  },
};

const SPACES: Space[] = [{ id: "main", name: "主空间", color: 0 }];
const store: LayoutStore = { load: () => LAYOUT, save: () => {} };
const entries = (): ContentEntry[] =>
  NOTES.map((n) => ({
    id: n.id,
    title: n.title,
    path: "示例",
    icon: "file",
    tags: [],
    privacy: levelOf(n.id),
    recent: 1,
  }));

function Page() {
  const t = useT();
  const [ws, setWs] = useState<WorkspaceApi | null>(null);
  const [activeLevel, setActiveLevel] = useState<PrivacyLevel>("normal");
  const [activeNote, setActiveNote] = useState<string | undefined>();
  useStore();
  useEffect(() => {
    if (!ws) return;
    const sync = () => {
      const id = ws.tabs().find((x) => x.isActive)?.contentId;
      setActiveNote(id);
      setActiveLevel(id ? levelOf(id) : "normal");
    };
    const off = ws.subscribe(sync);
    const offLevels = subscribe(sync);
    sync();
    return () => {
      off();
      offLevels();
    };
  }, [ws]);
  const setActive = useCallback((l: PrivacyLevel) => {
    const id = window.__ws?.tabs().find((x) => x.isActive)?.contentId;
    if (id && levels.has(id)) {
      levels.set(id, l);
      changed();
    }
  }, []);
  useEffect(() => {
    const offCommand = registerPrivacyCommand(t, () => {}, setActive);
    const offContent = registerSource(
      contentSource(t, entries, (e) => window.__ws && openNote(window.__ws, e.id)),
    );
    return () => {
      offCommand();
      offContent();
    };
  }, [t, setActive]);
  const note = NOTES.find((n) => n.id === activeNote);
  return (
    <>
      <Shell
        spaces={SPACES}
        space="main"
        onSpace={() => {}}
        onNewSpace={() => {}}
        views={[]}
        view=""
        onView={() => {}}
        notifications={[]}
        layouts={store}
        statusLeft={note ? [t("status.saved"), <PrivacyMark key="p" level={activeLevel} />] : []}
        statusRight={[t("status.offline")]}
        contentPrivacy={activeLevel}
        onSpaceColor={() => {}}
        onReady={(api) => {
          const first = api.tabs().find((x) => x.contentId === "lesson");
          if (first) api.activate(first.id);
          window.__ws = api;
          setWs(api);
        }}
        home={{ widgets: [], onOpenNode: () => {} }}
        renderView={() => null}
      />
      <ToastRegion />
    </>
  );
}

export function PrivacyScreens() {
  const a = useAppearance();
  return (
    <GlassProvider
      accent={SPACES[0] ? spaceColors(SPACES[0], a.scheme)[0] : undefined}
      settings={a.glass}
      onSettingsChange={(glass) => setAppearance({ glass })}
    >
      <Page />
    </GlassProvider>
  );
}
