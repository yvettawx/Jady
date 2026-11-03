// Review page for P0.5-09, development builds only: #/screens/ai. The real shell with notes at
// each level and AI chats whose answers are made up here: nothing talks to an AI. What a chat may
// mention goes through aiLink, as the gateway's output will. P3 connects the real thing.
import { registerAiSection } from "../../settings/SettingsPanel";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatView } from "../../ai/ChatView";
import { ChatWindow } from "../../ai/ChatWindow";
import { ProposalContext, useProposals } from "../../ai/context";
import { planSize, type Harvest } from "../../ai/harvest";
import { HarvestSheet } from "../../ai/HarvestSheet";
import { MINE, type SourceInfo } from "../../ai/source";
import { SourceButton } from "../../ai/SourceMarks";
import { ProposalDot, ProposalList } from "../../ai/ProposalCard";
import { createProposalStore, type Proposal } from "../../ai/proposals";
import { SessionMarks } from "../../ai/SessionMarks";
import type { Chat, ChatHandlers, ChatMessage, ChatPart } from "../../ai/types";
import { InterlinearBlock, type InterlinearLine } from "../../editor/blocks/InterlinearBlock";
import "../../editor/blocks/blocks.css";
import { NoteSheet } from "../../editor/NoteSheet";
import type { SheetMode } from "../../editor/mode";
import { TextMenu } from "../../editor/TextMenu";
import { useT } from "../../i18n/context";
import type { Rating, ReviewCard } from "../../learn/review";
import { ReviewSession } from "../../learn/ReviewSession";
import { reviewedBy, type Correction, type DueWord } from "../../learn/talk";
import { TalkPage, type TalkTurn } from "../../learn/TalkPage";
import { useAiGate } from "../../privacy/AiGate";
import { aiLink, type AiSession } from "../../privacy/policy";
import { PrivacyPicker } from "../../privacy/PrivacyPicker";
import { setAppearance, useAppearance } from "../../settings/appearance";
import { Shell, HOME_PANEL, type LayoutStore } from "../../shell/Shell";
import { spaceColors, type Space } from "../../shell/spaces";
import { PrivacyMark, type PrivacyLevel } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { Tree } from "../../ui/Tree";
import type { WorkspaceApi } from "../../workspace/api";
import type { Layout, SavedTab } from "../../workspace/layout";
import { OpenList } from "../../workspace/OpenList";
import { registerPanel, type PanelProps } from "../../workspace/registry";
import "../lab.css";

interface DemoNote {
  id: string;
  title: string;
  no: string;
  level: PrivacyLevel;
  aiWeb?: boolean;
  source?: SourceInfo;
  paragraphs: string[];
}

registerAiSection();

const PARA_1 = "复合过去时用来讲已经完成的动作。它由助动词加过去分词组成。";
const PARA_2 = "大多数动词用 avoir，少数用 être。";
const PARA_3 = "这一段以后再看。";
const PARA_11 = "être 和 avoir 是两个最常用的助动词。";

const notes = new Map<string, DemoNote>(
  (
    [
      {
        id: "lesson",
        title: "第 12 课 Le passé composé",
        no: "0142",
        level: "normal",
        paragraphs: [PARA_1, PARA_2, PARA_3],
      },
      {
        id: "lesson11",
        title: "第 11 课 être 和 avoir",
        no: "0141",
        level: "normal",
        paragraphs: [PARA_11],
        source: { origin: "aiMemory", needsCheck: true, refs: [] },
      },
      {
        id: "composter",
        title: "车票还要打票吗",
        no: "0190",
        level: "normal",
        paragraphs: ["以前上车前要在黄色机器上打票，现在电子票不用了，纸票各地说法不一。"],
        source: {
          origin: "aiSearch",
          needsCheck: false,
          conflict: true,
          refs: ["SNCF 官网：纸票仍需打票", "旅行论坛 2025：多数线路已取消"],
          recheckOn: "2026-10-01",
        },
      },
      {
        id: "resume",
        title: "投递资料",
        no: "0178",
        level: "sensitive",
        paragraphs: ["实习 A 下周一再问。这一篇放对外用的简历要点。"],
      },
      {
        id: "salary",
        title: "期望薪资",
        no: "0179",
        level: "sensitive",
        paragraphs: ["几家公司给的数字和我的底线。"],
      },
      {
        id: "diary",
        title: "10月17日",
        no: "0217",
        level: "private",
        paragraphs: ["今天去了里昂。火车晚点四十分钟。"],
      },
    ] satisfies DemoNote[]
  ).map((n) => [n.id, n]),
);

type Place = "window" | "dock" | "closed";
const chats = new Map<string, { chat: Chat; place: Place }>();

const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};
const subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
const useStore = () => useSyncExternalStore(subscribe, () => version);

let seq = 0;
const nextId = () => `m${++seq}`;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const update = (id: string, f: (c: Chat) => Chat) => {
  const entry = chats.get(id);
  if (entry) {
    entry.chat = f(entry.chat);
    changed();
  }
};
const setPlace = (id: string, place: Place) => {
  const entry = chats.get(id);
  if (entry) {
    entry.place = place;
    changed();
  }
};
const setNote = (id: string, patch: Partial<DemoNote>) => {
  const n = notes.get(id);
  if (n) {
    Object.assign(n, patch);
    changed();
  }
};
const push = (id: string, m: ChatMessage) =>
  update(id, (c) => ({ ...c, messages: [...c.messages, m] }));

/** What this session may mention: everything else comes out as 受保护的内容. */
const readable = (session: AiSession): ChatPart[] => {
  const parts: ChatPart[] = ["这个对话里，相关的内容有："];
  [...notes.values()].forEach((n, i) => {
    if (i) parts.push("、");
    parts.push(aiLink(n, session));
  });
  parts.push("。");
  return parts;
};

const timers = new Map<string, ReturnType<typeof setInterval>>();
/** A made-up answer arriving a few characters at a time. */
function streamSay(id: string, text: string, then?: () => void) {
  const m = nextId();
  update(id, (c) => ({ ...c, running: true }));
  if (reduceMotion()) {
    push(id, { id: m, kind: "say", parts: [text] });
    update(id, (c) => ({ ...c, running: false }));
    return then?.();
  }
  push(id, { id: m, kind: "say", parts: [""] });
  let at = 0;
  timers.set(
    id,
    setInterval(() => {
      at += 2;
      update(id, (c) => ({
        ...c,
        messages: c.messages.map((x) =>
          x.id === m ? { ...x, parts: [text.slice(0, at)] } : x,
        ) as ChatMessage[],
      }));
      if (at >= text.length) {
        stop(id);
        then?.();
      }
    }, 30),
  );
}
function stop(id: string) {
  clearInterval(timers.get(id));
  timers.delete(id);
  update(id, (c) => ({ ...c, running: false }));
}

const summary = (): ChatMessage => ({
  id: nextId(),
  kind: "generated",
  title: "第 12 课的总结",
  text: "复合过去时讲已经完成的动作：助动词加过去分词。多数动词用 avoir，表示移动和状态变化的用 être，这时过去分词要和主语配合。",
});
const FR = { id: "fr", label: "法语" };
const LESSON = { id: "lesson", title: "第 12 课 Le passé composé" };
const proposals = createProposalStore({
  isCurrent: (p) => {
    const n = notes.get(p.target.id);
    return !!n && p.before.every((b) => n.paragraphs.includes(b));
  },
  apply: (p) => {
    const n = notes.get(p.target.id);
    if (!n) return;
    n.paragraphs = n.paragraphs.flatMap((t) => (t === p.before[0] ? p.after : [t]));
    changed();
  },
  revert: (p) => {
    const n = notes.get(p.target.id);
    if (!n) return;
    const at = p.after[0] ? n.paragraphs.indexOf(p.after[0]) : -1;
    if (at >= 0) n.paragraphs = n.paragraphs.map((t, i) => (i === at ? (p.before[0] ?? t) : t));
    else n.paragraphs = [...n.paragraphs, ...p.before];
    changed();
  },
});

const tidyLesson = (id: string, patch: Partial<Proposal>): Omit<Proposal, "state"> => ({
  id,
  action: "tidy",
  scope: FR,
  summary: "",
  target: LESSON,
  privacy: "normal",
  before: [],
  after: [],
  ...patch,
});
function seedProposals() {
  if (proposals.list().length) return;
  proposals.add(
    tidyLesson("p-first", {
      summary: "第一段写清楚一点",
      before: [PARA_1],
      after: ["复合过去时（le passé composé）用来讲已经完成的动作。它由助动词加过去分词组成。"],
    }),
  );
  proposals.add(
    tidyLesson("p-second", {
      summary: "说清楚哪些动词用 être",
      before: [PARA_2],
      after: ["大多数动词用 avoir，表示位置移动和状态变化的十几个动词用 être。"],
    }),
  );
  proposals.add(
    tidyLesson("p-other", {
      action: "merge",
      summary: "和第 11 课的说法合并",
      before: [PARA_2],
      after: ["助动词的选法见第 11 课：多数用 avoir，少数用 être。"],
    }),
  );
  proposals.add(
    tidyLesson("p-delete", {
      action: "delete",
      summary: "删掉这一段，它已经没有内容了",
      before: [PARA_3],
      after: [],
    }),
  );
}
let later = 0;
/** One more, on another note: if you allowed 整理 in 法语, it goes straight through. */
const organize = (): ChatMessage => {
  const id = `p-later-${++later}`;
  proposals.add({
    id,
    action: "tidy",
    scope: FR,
    summary: "第 11 课开头写清楚一点",
    target: { id: "lesson11", title: "第 11 课 être 和 avoir" },
    privacy: "normal",
    before: [notes.get("lesson11")?.paragraphs[0] ?? PARA_11],
    after: [`${notes.get("lesson11")?.paragraphs[0] ?? PARA_11}下一课的复合过去时要用到它们。`],
  });
  return { id: nextId(), kind: "proposal", proposal: id };
};

function startChat(note: DemoNote, session: AiSession, quote?: string) {
  const open = [...chats.values()].find(
    (e) => e.place !== "closed" && e.chat.tabContent === note.id && e.chat.session === session,
  );
  if (open) return open.chat.id;
  const id = `chat-${++seq}`;
  chats.set(id, {
    place: "window",
    chat: {
      id,
      title: note.title,
      session,
      tabContent: note.id,
      quote,
      messages:
        session === "plain" ? [] : [{ id: nextId(), kind: "say", parts: readable(session) }],
      running: false,
    },
  });
  changed();
  return id;
}

/** The first chat, with all three things AI does, so the page has something to look at. */
function seed() {
  if (chats.size) return;
  const lesson = notes.get("lesson");
  if (!lesson) return;
  seedProposals();
  const id = startChat(lesson, "plain");
  update(id, (c) => ({
    ...c,
    messages: [
      { id: nextId(), kind: "me", text: "什么时候用 être？" },
      {
        id: nextId(),
        kind: "say",
        parts: [
          "表示位置移动和状态变化的动词用 être，比如 aller、venir、naître。其他的用 avoir。可以看 ",
          aiLink(lesson, "plain"),
          "。",
        ],
      },
      { id: nextId(), kind: "me", text: "composter 现在还要吗" },
      {
        id: nextId(),
        kind: "say",
        parts: ["我印象里纸票还要打票，但这几年改过，没把握。"],
        source: { origin: "aiMemory", needsCheck: true, refs: [] },
      },
      { id: nextId(), kind: "me", text: "查一下" },
      {
        id: nextId(),
        kind: "say",
        parts: ["查到两种说法，对不上。我放进了“车票还要打票吗”。"],
        source: {
          origin: "aiSearch",
          needsCheck: false,
          conflict: true,
          refs: ["SNCF 官网：纸票仍需打票", "旅行论坛 2025：多数线路已取消"],
        },
      },
      { id: nextId(), kind: "me", text: "总结成一段" },
      summary(),
      { id: nextId(), kind: "me", text: "第一段帮我写清楚" },
      { id: nextId(), kind: "proposal", proposal: "p-first" },
    ],
  }));
}

const openNote = (ws: WorkspaceApi | undefined, id: string) => {
  if (!ws) return;
  const tab = ws.tabs().find((x) => x.contentId === id);
  if (tab) return ws.activate(tab.id);
  const n = notes.get(id);
  if (n)
    ws.open({ contentId: id, title: n.title, component: "ai-note", params: { privacy: n.level } });
};

function handlers(id: string): ChatHandlers {
  const lessonNote = () => notes.get(chats.get(id)?.chat.tabContent ?? "");
  return {
    onSend(text) {
      push(id, { id: nextId(), kind: "me", text });
      if (/总结/.test(text)) streamSay(id, "好，这是总结：", () => push(id, summary()));
      else if (/整理|写清楚/.test(text))
        streamSay(id, "这是我的提议：", () => push(id, organize()));
      else streamSay(id, "（开发版）这里是 AI 的回答，一点一点出现。接入 AI 是 P3 的事。");
    },
    onStop: () => stop(id),
    onPlace(messageId, where) {
      const entry = chats.get(id);
      const m = entry?.chat.messages.find((x) => x.id === messageId);
      if (m?.kind !== "generated") return;
      if (where === "insert") {
        const n = lessonNote();
        if (n) n.paragraphs = [...n.paragraphs, m.text];
      } else {
        const note: DemoNote = {
          id: `new-${messageId}`,
          title: m.title,
          no: "0400",
          level: "normal",
          paragraphs: [m.text],
        };
        notes.set(note.id, note);
        openNote(window.__ws, note.id);
      }
      update(id, (c) => ({
        ...c,
        messages: c.messages.map((x) => (x.id === messageId ? { ...x, placed: where } : x)),
      }));
    },
    onUnplace(messageId) {
      const entry = chats.get(id);
      const m = entry?.chat.messages.find((x) => x.id === messageId);
      if (m?.kind !== "generated") return;
      const n = lessonNote();
      if (m.placed === "insert" && n) n.paragraphs = n.paragraphs.filter((p) => p !== m.text);
      if (m.placed === "save") {
        const ws = window.__ws;
        const tab = ws?.tabs().find((x) => x.contentId === `new-${messageId}`);
        if (tab) ws?.close(tab.id);
        notes.delete(`new-${messageId}`);
      }
      update(id, (c) => ({
        ...c,
        messages: c.messages.map((x) =>
          x.id === messageId ? { ...x, placed: undefined } : x,
        ) as ChatMessage[],
      }));
    },
    onOpen: (noteId) => openNote(window.__ws, noteId),
  };
}

function NotePanel({ contentId, tabId, workspace }: PanelProps) {
  useStore();
  const note = notes.get(contentId);
  const [mode, setMode] = useState<SheetMode>("edit");
  const gate = useAiGate(note?.level ?? "normal", note?.aiWeb);
  const waiting = useProposals().items.filter(
    (p) => p.state === "pending" && p.target.id === contentId,
  );
  useEffect(() => {
    if (note) workspace.setTabParams(tabId, { privacy: note.level });
  }, [workspace, tabId, note, note?.level]);
  if (!note) return null;
  const ask = (then?: (chat: string) => void, quote?: string) =>
    gate.request((session) => {
      const id = startChat(note, session, quote);
      then?.(id);
    });
  return (
    <>
      <NoteSheet
        number={note.no}
        kind="笔记"
        date="10月24日"
        title={note.title}
        mode={mode}
        onMode={setMode}
        onFormat={() => {}}
        privacy={note.level}
        onAi={(action) =>
          ask((id) => handlers(id).onSend(action === "summary" ? "总结这篇" : "整理这篇"))
        }
        meta={
          <>
            <SourceButton
              source={note.source ?? MINE}
              onChange={(source) => setNote(contentId, { source })}
            />
            <PrivacyPicker
              level={note.level}
              aiWeb={note.aiWeb}
              onLevel={(l) => {
                // The mark only means something on 敏感.
                setNote(contentId, { level: l, aiWeb: l === "sensitive" ? note.aiWeb : false });
              }}
              onAiWeb={(on) => {
                setNote(contentId, { aiWeb: on });
              }}
            />
          </>
        }
      >
        <TextMenu
          privacy={note.level}
          onAction={(a) => {
            if (a === "ask-ai") ask(undefined, getSelection()?.toString() || undefined);
            else showToast({ text: `（开发版）${a}` });
          }}
        >
          <div
            className="dem-prose"
            data-mode={mode}
            contentEditable={mode === "edit"}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline
            aria-label="正文"
          >
            {note.paragraphs.map((text) => (
              <p key={text} style={{ position: "relative" }}>
                {text}
                {waiting.find((p) => p.before[0] === text) && (
                  <ProposalDot
                    id={waiting.find((p) => p.before[0] === text)?.id ?? ""}
                    onOpen={(id) => openNote(workspace, id)}
                  />
                )}
              </p>
            ))}
          </div>
        </TextMenu>
      </NoteSheet>
      {gate.dialog}
    </>
  );
}

function ChatPanel({ contentId, workspace, tabId }: PanelProps) {
  const t = useT();
  useStore();
  const entry = chats.get(contentId);
  if (!entry) return null;
  return (
    <div className="dem-chat-pane">
      <div className="dem-chat-pane-head">
        <SessionMarks session={entry.chat.session} />
        <span className="dem-chat-gap" />
        <Button
          variant="quiet"
          size="sm"
          icon="app-window"
          aria-label={t("ai.undock")}
          onPress={() => {
            setPlace(contentId, "window");
            workspace.close(tabId);
          }}
        />
      </div>
      <ChatView chat={entry.chat} on={handlers(contentId)} />
    </div>
  );
}

/** What a French chat at the station turned up. 09-5 opens this from its 结束 button. */
const HARVEST: Harvest = {
  summary:
    "这次练的是在车站问路和买票。你能说清楚要去哪里，但复合过去时的助动词还会选错，和上周一样。",
  words: [
    { id: "w-quai", word: "le quai", meaning: "站台", example: "Le train part de quel quai ?" },
    {
      id: "w-guichet",
      word: "le guichet",
      meaning: "售票窗口",
      example: "Où est le guichet, s'il vous plaît ?",
    },
    {
      id: "w-retard",
      word: "le retard",
      meaning: "晚点",
      example: "Le train a vingt minutes de retard.",
    },
  ],
  grammar: [
    {
      id: "g-etre",
      title: "移动动词用 être",
      note: "aller、partir、arriver 的复合过去时用 être，过去分词要和主语配合。",
      link: { id: "lesson", title: "第 12 课 Le passé composé" },
    },
  ],
  mistakes: [
    {
      id: "m-aux",
      wrong: "J'ai allé à la gare.",
      right: "Je suis allé à la gare.",
      why: "aller 用 être。",
      pattern: { id: "pattern-aux", name: "助动词选错", times: 2 },
    },
    { id: "m-gender", wrong: "le gare", right: "la gare", why: "gare 是阴性。" },
  ],
  loose: [
    { id: "l-tickets", text: "买往返票的说法还没练" },
    { id: "l-q", text: "composter 现在还常用吗，没有说完" },
  ],
};
/** The cards that exist already: le quai is one, so it only gains the example. */
const CARDS = new Map([["quai", "card-quai"]]);

function HarvestPanel({ workspace }: PanelProps) {
  return (
    <HarvestSheet
      harvest={HARVEST}
      cards={CARDS}
      onSave={(plan) => showToast({ text: `（开发版）存入 ${planSize(plan)} 项` })}
      onUndo={() => showToast({ text: "（开发版）已撤销" })}
      onDiscard={() => showToast({ text: "（开发版）已放弃" })}
      onOpen={(id) => openNote(workspace, id)}
    />
  );
}

const INTER_ZH: InterlinearLine[] = [
  {
    words: [
      { text: "学", translit: "xué", gloss: "学习" },
      { text: "而", translit: "ér", gloss: "并且" },
      { text: "时", translit: "shí", gloss: "按时" },
      { text: "习", translit: "xí", gloss: "温习" },
      { text: "之", translit: "zhī", gloss: "它" },
      { text: "，", translit: "", gloss: "" },
      { text: "不", translit: "bù", gloss: "不" },
      { text: "亦", translit: "yì", gloss: "也" },
      { text: "说", translit: "yuè", gloss: "高兴" },
      { text: "乎", translit: "hū", gloss: "吗" },
    ],
    translation: "学了又按时温习，不也很高兴吗？",
  },
];
const INTER_FR: InterlinearLine[] = [
  {
    words: [
      { text: "Je", translit: "/ʒə/", gloss: "我" },
      { text: "suis", translit: "/sɥi/", gloss: "助动词 être" },
      { text: "allé", translit: "/ale/", gloss: "去（过去分词）" },
      { text: "à", translit: "/a/", gloss: "到" },
      { text: "la", translit: "/la/", gloss: "阴性冠词" },
      { text: "gare", translit: "/ɡaʁ/", gloss: "火车站" },
    ],
    translation: "我去了火车站。",
  },
];
function InterPanel() {
  return (
    <div className="dem-sheet">
      <div className="dem-sheet-body">
        <div className="dem-sheet-page">
          <div className="dem-prose">
            <InterlinearBlock lines={INTER_ZH} lang="zh-Hans" />
            <InterlinearBlock lines={INTER_FR} lang="fr" />
          </div>
        </div>
      </div>
    </div>
  );
}

const TALK_DUE: DueWord[] = [
  { id: "c-quai", word: "le quai" },
  { id: "c-guichet", word: "le guichet" },
  { id: "c-retard", word: "le retard" },
];
const OPENING: TalkTurn = {
  id: "t0",
  who: "partner",
  text: "Bonjour ! Nous sommes à la gare. Où voulez-vous aller ?",
  gloss: "你好！我们在火车站。你想去哪里？",
};
const REPLIES: Pick<TalkTurn, "text" | "gloss">[] = [
  { text: "Très bien. Le train part du quai numéro deux.", gloss: "好的。火车从 2 号站台出发。" },
  { text: "Attention, il a dix minutes de retard.", gloss: "注意，它晚点十分钟。" },
  { text: "Vous avez déjà votre billet ?", gloss: "你已经有票了吗？" },
];
/** A stand-in for the partner noticing mistakes: P3 gets these from AI. */
const KNOWN_MISTAKES: Omit<Correction, "id" | "turn">[] = [
  { wrong: "J'ai allé", right: "Je suis allé", why: "aller 用 être。" },
  { wrong: "le gare", right: "la gare", why: "gare 是阴性。" },
  { wrong: "la guichet", right: "le guichet", why: "guichet 是阳性。" },
];

function TalkPanel({ workspace }: PanelProps) {
  const [turns, setTurns] = useState<TalkTurn[]>([OPENING]);
  const [fixes, setFixes] = useState<Correction[]>([]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [typing, setTyping] = useState(false);
  const [ended, setEnded] = useState(false);
  const replies = useRef(0);
  if (ended) {
    return (
      <HarvestSheet
        harvest={{
          ...HARVEST,
          mistakes: fixes.map((f) => ({
            id: f.id,
            wrong: f.wrong,
            right: f.right,
            why: f.why,
            pattern:
              f.right === "Je suis allé"
                ? { id: "pattern-aux", name: "助动词选错", times: 2 }
                : undefined,
          })),
        }}
        cards={CARDS}
        onSave={(plan) => showToast({ text: `（开发版）存入 ${planSize(plan)} 项` })}
        onUndo={() => showToast({ text: "（开发版）已撤销" })}
        onDiscard={() => showToast({ text: "（开发版）已放弃" })}
        onOpen={(id) => openNote(workspace, id)}
      />
    );
  }
  return (
    <TalkPage
      title="在火车站"
      turns={turns}
      corrections={fixes}
      due={TALK_DUE}
      reviewed={reviewed}
      typing={typing}
      onEnd={() => setEnded(true)}
      onSend={(text) => {
        const turn = `t${++seq}`;
        const found = KNOWN_MISTAKES.filter((m) => text.includes(m.wrong));
        setTurns((x) => [...x, { id: turn, who: "me", text }]);
        const hits = reviewedBy(text, TALK_DUE, reviewed, found);
        if (hits.length) setReviewed((x) => new Set([...x, ...hits.map((d) => d.id)]));
        setTyping(true);
        // Corrections arrive on their own, a little after; the conversation carries on regardless.
        setTimeout(() => {
          setFixes((x) => [...x, ...found.map((m, i) => ({ ...m, id: `${turn}-${i}`, turn }))]);
          const reply = REPLIES[replies.current++ % REPLIES.length];
          if (reply) setTurns((x) => [...x, { id: `t${++seq}`, who: "partner", ...reply }]);
          setTyping(false);
        }, 500);
      }}
    />
  );
}

const REVIEW_CARDS: ReviewCard[] = [
  { id: "c1", front: "le quai", back: "站台", example: "Le train part de quel quai ?" },
  {
    id: "c2",
    front: "Je ___ allé à la gare.（助动词）",
    back: "suis",
    example: "Je suis allé à la gare.",
  },
  { id: "c3", front: "le guichet", back: "售票窗口", example: "Où est le guichet ?" },
  { id: "c4", front: "avoir 的过去分词", back: "eu", example: "J'ai eu de la chance." },
  { id: "c5", front: "le retard", back: "晚点", example: "Le train a du retard." },
];
const INTERVALS: Record<Rating, string> = {
  again: "10 分钟",
  hard: "1 天",
  good: "4 天",
  easy: "12 天",
};
function ReviewPanel({ workspace, tabId }: PanelProps) {
  const active = useSyncExternalStore(
    workspace.subscribe,
    () => workspace.tabs().find((x) => x.id === tabId)?.isActive ?? false,
  );
  return <ReviewSession cards={REVIEW_CARDS} intervalOf={(_, r) => INTERVALS[r]} active={active} />;
}

function NavPanel({ workspace }: PanelProps) {
  useStore();
  return (
    <Tree
      aria-label="目录"
      onAction={(id) => openNote(workspace, String(id))}
      items={[...notes.values()].map((n) => ({
        id: n.id,
        label: n.title,
        icon: "file",
        trailing: <PrivacyMark level={n.level} />,
      }))}
    />
  );
}

/** Every chat is kept: a closed one comes back from here (§5.3). */
function RecordsPanel({ workspace }: PanelProps) {
  const t = useT();
  useStore();
  return (
    <Tree
      aria-label={t("ai.records")}
      onAction={(id) => {
        const place = chats.get(String(id))?.place;
        if (place === "closed") setPlace(String(id), "window");
        else if (place === "dock") {
          const tab = workspace.tabs().find((x) => x.contentId === id);
          if (tab) workspace.activate(tab.id);
        }
      }}
      items={[...chats.values()].map(({ chat }) => ({
        id: chat.id,
        label: chat.title,
        icon: "ai",
        trailing: <SessionMarks session={chat.session} />,
      }))}
    />
  );
}

registerPanel({ id: "ai-note", icon: "file", render: NotePanel });
registerPanel({ id: "ai-harvest", icon: "check", render: HarvestPanel });
registerPanel({ id: "ai-review", icon: "card", render: ReviewPanel });
registerPanel({ id: "ai-talk", icon: "chat", render: TalkPanel });
registerPanel({ id: "ai-inter", icon: "translate", render: InterPanel });
registerPanel({ id: "ai-chat", icon: "ai", render: ChatPanel });
registerPanel({ id: "ai-nav", icon: "tree", role: "widget", render: NavPanel });
registerPanel({ id: "ai-records", icon: "ai", role: "widget", render: RecordsPanel });
registerPanel({
  id: "ai-proposals",
  icon: "ai",
  role: "widget",
  render: ({ workspace }) => <ProposalList onOpen={(id) => openNote(workspace, id)} />,
});
registerPanel({
  id: "ai-open",
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
      size: 0.22,
      cells: [
        { size: 0.26, tabs: ["open"] },
        { size: 0.2, tabs: ["nav"] },
        { size: 0.54, tabs: ["records", "proposals"], active: "proposals" },
      ],
    },
    {
      size: 0.78,
      cells: [
        {
          size: 1,
          tabs: [
            "home",
            ...[...notes.values()].map((n) => n.id),
            "harvest",
            "review",
            "talk",
            "inter",
          ],
          active: "lesson",
        },
      ],
    },
  ],
  floating: [],
  tabs: {
    open: { ...tab("open", "ai-open", "打开的内容"), kind: "pin" },
    nav: { ...tab("nav", "ai-nav", "目录"), kind: "pin" },
    records: { ...tab("records", "ai-records", "AI 对话"), kind: "pin" },
    proposals: { ...tab("proposals", "ai-proposals", "AI 提议"), kind: "pin" },
    home: { ...tab("home", HOME_PANEL, "首页"), kind: "pin" },
    harvest: tab("harvest", "ai-harvest", "本次收获"),
    review: tab("review", "ai-review", "记忆卡复习"),
    talk: tab("talk", "ai-talk", "法语实时对话"),
    inter: tab("inter", "ai-inter", "对照文本"),
    ...Object.fromEntries(
      [...notes.values()].map((n) => [n.id, tab(n.id, "ai-note", n.title, n.level)]),
    ),
  },
};
const SPACES: Space[] = [{ id: "main", name: "主空间", color: 0 }];
const store: LayoutStore = { load: () => LAYOUT, save: () => {} };

function Page() {
  const t = useT();
  useStore();
  const [active, setActive] = useState<string | undefined>();
  const wsRef = useRef<WorkspaceApi | null>(null);
  useEffect(() => seed(), []);
  const note = active ? notes.get(active) : undefined;
  const windows = [...chats.values()].filter((e) => e.place === "window");
  const running = [...chats.values()].filter((e) => e.chat.running).length;
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
        statusLeft={note ? [t("status.saved"), <PrivacyMark key="p" level={note.level} />] : []}
        statusRight={[
          ...(running ? [t("status.aiRunning", { n: running })] : []),
          t("status.offline"),
        ]}
        contentPrivacy={note?.level ?? "normal"}
        contentAiWeb={note?.aiWeb ?? false}
        onSpaceColor={() => {}}
        onReady={(api) => {
          wsRef.current = api;
          window.__ws = api;
          const sync = () => {
            setActive(api.tabs().find((x) => x.isActive)?.contentId);
            // A chat's tab was closed: the chat is kept, and comes back from AI 对话.
            for (const e of chats.values())
              if (e.place === "dock" && !api.tabs().some((x) => x.contentId === e.chat.id))
                setPlace(e.chat.id, "closed");
          };
          api.subscribe(sync);
          const first = api.tabs().find((x) => x.contentId === "lesson");
          if (first) api.activate(first.id);
          sync();
        }}
        home={{ widgets: [], onOpenNode: () => {} }}
        renderView={() => null}
      />
      {windows.map((e, i) => (
        <ChatWindow
          key={e.chat.id}
          chat={e.chat}
          index={i}
          on={handlers(e.chat.id)}
          onClose={() => {
            setPlace(e.chat.id, "closed");
          }}
          onDock={() => {
            setPlace(e.chat.id, "dock");
            wsRef.current?.open({
              contentId: e.chat.id,
              title: e.chat.title,
              component: "ai-chat",
              params: { session: e.chat.session },
            });
          }}
        />
      ))}
      <ToastRegion />
    </>
  );
}

export function AiScreens() {
  const a = useAppearance();
  return (
    <GlassProvider
      accent={SPACES[0] ? spaceColors(SPACES[0], a.scheme)[0] : undefined}
      settings={a.glass}
      onSettingsChange={(glass) => setAppearance({ glass })}
    >
      <ProposalContext.Provider value={proposals}>
        <Page />
      </ProposalContext.Provider>
    </GlassProvider>
  );
}
