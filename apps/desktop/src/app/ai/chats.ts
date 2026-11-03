// The AI chats that are open: one store whichever place shows them. It starts sessions through the
// core and follows their events. It knows nothing about which provider is behind them.
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { ChatMessage, Chat, ChatPart } from "../../ai/types";
import { aiLink, type AiSession } from "../../privacy/policy";
import { showToast } from "../../ui/toast";
import { api, itemsChanged } from "../api";
import { levelOf } from "../model";
import { library } from "../store";

export type ChatMode = "chat" | "lecture" | "talk" | "explain" | "judge" | "task";

export interface LiveChat extends Chat {
  mode: ChatMode;
  container: string | null;
  /** Told to AI ahead of the first message, not shown: what was selected, and from where. */
  context: string | null;
  /** Tools being called in this turn, for the quiet line under the answer. */
  tool: string | null;
  tokens: number;
}

const chats = new Map<string, LiveChat>();
let snapshot: LiveChat[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const changed = () => {
  snapshot = [...chats.values()];
  listeners.forEach((f) => f());
};

const proposalListeners = new Set<() => void>();
/** Runs `f` when AI has proposed something. */
export function onProposal(f: () => void) {
  proposalListeners.add(f);
  return () => proposalListeners.delete(f);
}

/** The raw text of each answer, before links and app-only blocks are taken out. */
const raw = new Map<string, string>();
/** Whoever waits for the turn in progress. */
const waiting = new Map<string, ((answer: string) => void)[]>();
/** A closing turn's text is for the app, not for the chat. */
const silent = new Set<string>();

const APP_BLOCKS = /```(corrections|verdict|harvest)[\s\S]*?(```|$)/g;

/** Turns [[item:ID]] into links: what this session cannot read shows no title. */
export function partsOf(text: string, session: AiSession): ChatPart[] {
  const parts: ChatPart[] = [];
  const shown = text.replace(APP_BLOCKS, "").trimEnd();
  for (const piece of shown.split(/(\[\[item:[^\]]+\]\])/)) {
    const m = /^\[\[item:([^\]]+)\]\]$/.exec(piece);
    if (!m) {
      if (piece) parts.push(piece);
      continue;
    }
    const item = library().items.find((i) => i.id === m[1]);
    parts.push(
      aiLink(
        item
          ? {
              id: item.id,
              title: item.title ?? "",
              level: levelOf(item.privacy),
              aiWeb: item.aiWeb,
            }
          : null,
        session,
      ),
    );
  }
  return parts;
}

function patch(id: string, f: (c: LiveChat) => Partial<LiveChat>) {
  const c = chats.get(id);
  if (!c) return;
  chats.set(id, { ...c, ...f(c) });
  changed();
}

const nextId = () => `m${++seq}`;

interface AiEventPayload {
  session: string;
  type: string;
  text?: string;
  message?: string;
  name?: string;
  index?: number;
  title?: string;
  id?: string;
  itemType?: string;
  origin?: string;
  needsCheck?: boolean;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function onEvent(e: AiEventPayload) {
  const id = e.session;
  const chat = chats.get(id);
  if (!chat) return;
  switch (e.type) {
    case "text": {
      const all = (raw.get(id) ?? "") + (e.text ?? "");
      raw.set(id, all);
      if (silent.has(id)) return;
      patch(id, (c) => {
        const last = c.messages.at(-1);
        const parts = partsOf(all, c.session);
        const say: ChatMessage =
          last?.kind === "say" ? { ...last, parts } : { id: nextId(), kind: "say", parts };
        return {
          tool: null,
          messages: last?.kind === "say" ? [...c.messages.slice(0, -1), say] : [...c.messages, say],
        };
      });
      return;
    }
    case "tool":
      patch(id, () => ({ tool: e.name ?? null }));
      return;
    case "offered":
      patch(id, (c) => ({
        messages: [
          ...c.messages,
          {
            id: `offered-${e.index ?? 0}`,
            kind: "generated",
            title: e.title ?? "",
            text: e.text ?? "",
            source: {
              origin: e.origin === "aiSearch" ? "aiSearch" : "aiMemory",
              needsCheck: e.needsCheck ?? false,
              refs: [],
            },
          },
        ],
      }));
      raw.set(id, "");
      return;
    case "proposal":
      patch(id, (c) => ({
        messages: [
          ...c.messages,
          { id: `p-${e.id ?? ""}`, kind: "proposal", proposal: e.id ?? "" },
        ],
      }));
      raw.set(id, "");
      proposalListeners.forEach((f) => f());
      return;
    case "annotation":
    case "reviewed":
      itemsChanged();
      return;
    case "usage":
      patch(id, (c) => ({
        tokens: c.tokens + (e.inputTokens ?? 0) + (e.outputTokens ?? 0),
      }));
      return;
    case "stopped":
      showToast({ text: e.reason ?? "" });
      return;
    case "error":
      showToast({ text: e.message ?? "", tone: "danger" });
      finishTurn(id, "");
      return;
    case "done":
      finishTurn(id, e.text ?? "");
      return;
  }
}

function finishTurn(id: string, answer: string) {
  patch(id, () => ({ running: false, tool: null }));
  for (const f of waiting.get(id) ?? []) f(answer);
  waiting.delete(id);
  itemsChanged();
}

let following = false;
export function followAi() {
  if (following) return;
  following = true;
  void listen<AiEventPayload>("ai-event", (e) => onEvent(e.payload));
}

export interface ChatStart {
  session: AiSession;
  mode: ChatMode;
  title: string;
  container?: string | null;
  quote?: string;
  tabContent?: string;
  context?: string;
}

export async function startChat(s: ChatStart): Promise<string> {
  followAi();
  const id = await api.aiStart({
    kind: s.session,
    mode: s.mode,
    container: s.container ?? null,
  });
  chats.set(id, {
    id,
    title: s.title,
    session: s.session,
    tabContent: s.tabContent,
    quote: s.quote,
    messages: [],
    running: false,
    mode: s.mode,
    container: s.container ?? null,
    context: s.context ?? null,
    tool: null,
    tokens: 0,
  });
  changed();
  return id;
}

/** Sends a message; resolves with the whole answer when the turn is over. */
export function sendChat(id: string, text: string, show = text): Promise<string> {
  raw.set(id, "");
  const context = chats.get(id)?.context;
  const message = context ? `${context}${text}` : text;
  patch(id, (c) => ({
    running: true,
    context: null,
    messages: show ? [...c.messages, { id: nextId(), kind: "me", text: show }] : c.messages,
  }));
  return new Promise((resolve) => {
    waiting.set(id, [...(waiting.get(id) ?? []), resolve]);
    void api.aiSend(id, message).catch((e: unknown) => {
      showToast({ text: e instanceof Error ? e.message : String(e), tone: "danger" });
      finishTurn(id, "");
    });
  });
}

export const stopChat = (id: string) => void api.aiStop(id);

/** The closing turn: its text comes back here and does not show in the chat. */
export function closingTurn(id: string): Promise<string> {
  raw.set(id, "");
  silent.add(id);
  patch(id, () => ({ running: true }));
  return new Promise((resolve) => {
    waiting.set(id, [
      (answer) => {
        silent.delete(id);
        resolve(answer);
      },
    ]);
    void api.aiCloseTurn(id).catch(() => {
      silent.delete(id);
      finishTurn(id, "");
    });
  });
}

/** Ends the session; its record is kept with the summary, what is open goes to 待补清单. */
export async function endChat(id: string, summary: string | null, loose: string[]) {
  chats.delete(id);
  changed();
  await api.aiEnd(id, summary, loose);
  itemsChanged();
}

export const getChat = (id: string) => chats.get(id);

export const useChats = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => snapshot,
  );

/** One ```name block's JSON from an answer. */
export function blockOf<T>(text: string, name: string): T | null {
  const m = new RegExp("```" + name + "\\s*([\\s\\S]*?)```").exec(text);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}
