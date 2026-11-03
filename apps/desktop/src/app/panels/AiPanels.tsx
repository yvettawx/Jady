/* eslint-disable react-refresh/only-export-components -- what starts a chat lives with the panels that show it */
// AI in the workbench (docs/05-design.md §5): chats docked or floating, the proposal list, 本次收获.
// Everything here works through the chat store; no panel knows which provider is behind it.
import { useEffect, useMemo, useState } from "react";
import { cardKey, planSize, type Harvest } from "../../ai/harvest";
import { useProposals } from "../../ai/context";
import { ChatView } from "../../ai/ChatView";
import { ChatWindow } from "../../ai/ChatWindow";
import { HarvestSheet } from "../../ai/HarvestSheet";
import { ProposalCard } from "../../ai/ProposalCard";
import type { Chat, ChatHandlers } from "../../ai/types";
import type { ItemView } from "../../bindings";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { EmptyState, Spinner } from "../../ui/States";
import { showToast } from "../../ui/toast";
import type { WorkspaceApi } from "../../workspace/api";
import type { PanelProps } from "../../workspace/registry";
import { failed, openById, openItem, trashItem } from "../actions";
import {
  closingTurn,
  endChat,
  sendChat,
  startChat,
  stopChat,
  useChats,
  type ChatStart,
  type LiveChat,
} from "../ai/chats";
import { cardIndex, parseHarvest, saveHarvest } from "../ai/harvest";
import { api, itemsChanged, parseFields } from "../api";
import { useLive } from "../live";
import { titleOf } from "../model";
import { AI_SEE_PANEL } from "./AiSearchPreview";

export const CHAT_PANEL = "ai-chat";
export const PROPOSALS_PANEL = "ai-proposals";
export const HARVEST_PANEL = "ai-harvest";

// --- Floating windows ---
let floating: string[] = [];
const floatListeners = new Set<() => void>();
const setFloating = (list: string[]) => {
  floating = list;
  floatListeners.forEach((f) => f());
};
export const floatChat = (id: string) => setFloating([...floating.filter((x) => x !== id), id]);
const unfloat = (id: string) => setFloating(floating.filter((x) => x !== id));

function useFloating() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    floatListeners.add(f);
    return () => {
      floatListeners.delete(f);
    };
  }, []);
  return floating;
}

/** Waiting results of closing turns, by chat, for the 本次收获 tab. */
const harvests = new Map<string, { harvest: Harvest; container: string | null }>();

/** Leaves a chat: asks for what it turned up, then shows it or just ends. */
export async function finishChat(
  chat: LiveChat,
  workspace: WorkspaceApi,
  t: (k: string) => string,
): Promise<void> {
  unfloat(chat.id);
  const said = chat.messages.some((m) => m.kind === "me");
  if (!said) {
    await endChat(chat.id, null, []);
    return;
  }
  const answer = await closingTurn(chat.id);
  const harvest = parseHarvest(answer);
  const learning = chat.mode !== "chat" && chat.mode !== "task";
  const empty =
    !harvest ||
    !(
      harvest.words.length ||
      harvest.grammar.length ||
      harvest.mistakes.length ||
      harvest.loose.length
    );
  if (learning && !empty && harvest) {
    harvests.set(chat.id, { harvest, container: chat.container });
    workspace.open({
      contentId: `harvest:${chat.id}`,
      title: t("harvest.tab"),
      component: HARVEST_PANEL,
      params: { chat: chat.id },
    });
    return;
  }
  await endChat(chat.id, harvest?.summary ?? null, harvest?.loose.map((l) => l.text) ?? []);
}

export function useChatHandlers(
  chat: Chat | undefined,
  workspace: WorkspaceApi | null,
): ChatHandlers {
  const t = useT();
  const id = chat?.id ?? "";
  return {
    onSend: (text) => void sendChat(id, text),
    onStop: () => stopChat(id),
    onOpen: (item) => workspace && openById(workspace, t, item, { kind: "temp" }),
    onPlace: (messageId, where) => {
      const index = Number(messageId.replace("offered-", ""));
      void api
        .aiPlace(id, index, where === "insert" ? (chat?.tabContent ?? null) : null)
        .then((r) => {
          placedMarks.set(`${id}:${messageId}`, { ...r, where });
          marksChanged();
          itemsChanged();
        })
        .catch(failed(t, t("ai.gen.save")));
    },
    onUnplace: (messageId) => {
      const mark = placedMarks.get(`${id}:${messageId}`);
      if (!mark) return;
      const undo = mark.proposal
        ? api.proposalUndo(mark.proposal).then(() => api.proposalIgnore(mark.proposal ?? ""))
        : api.itemGet(mark.item).then((item: ItemView) => trashItem(t, item));
      void undo
        .then(() => {
          placedMarks.delete(`${id}:${messageId}`);
          marksChanged();
          itemsChanged();
        })
        .catch(failed(t, t("ai.undo")));
    },
  };
}

const placedMarks = new Map<
  string,
  { item: string; proposal: string | null; where: "insert" | "save" }
>();
const markListeners = new Set<() => void>();
const marksChanged = () => markListeners.forEach((f) => f());
function useMarks() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    markListeners.add(f);
    return () => {
      markListeners.delete(f);
    };
  }, []);
}

function withMarks(chat: LiveChat): LiveChat {
  return {
    ...chat,
    messages: chat.messages.map((m) => {
      if (m.kind !== "generated") return m;
      const mark = placedMarks.get(`${chat.id}:${m.id}`);
      return mark ? { ...m, placed: mark.where } : { ...m, placed: undefined };
    }),
  };
}

function ChatBody({ chat, workspace }: { chat: LiveChat; workspace: WorkspaceApi }) {
  useMarks();
  const on = useChatHandlers(chat, workspace);
  return <ChatView chat={withMarks(chat)} on={on} autoFocus />;
}

export function ChatPanel({ contentId, workspace, tabId }: PanelProps) {
  const t = useT();
  const chats = useChats();
  const chat = chats.find((c) => c.id === contentId);
  if (!chat) return <EmptyState icon="chat" title={t("ai.chat.ended")} />;
  return (
    <div className="dem-chat-panel" data-focus-home="page" tabIndex={-1}>
      <header className="dem-chat-panel-head">
        <span className="dem-nav-title">{chat.title}</span>
        {chat.tool && (
          <span className="dem-nav-count">{t("ai.usingTool", { tool: chat.tool })}</span>
        )}
        <Button
          size="sm"
          isDisabled={chat.running}
          onPress={() => {
            workspace.close(tabId);
            void finishChat(chat, workspace, t).catch(failed(t, t("ai.end")));
          }}
        >
          {t("ai.end")}
        </Button>
      </header>
      <ChatBody chat={chat} workspace={workspace} />
    </div>
  );
}

function FloatingChat({
  chat,
  index,
  workspace,
}: {
  chat: LiveChat;
  index: number;
  workspace: WorkspaceApi;
}) {
  const t = useT();
  useMarks();
  const on = useChatHandlers(chat, workspace);
  return (
    <ChatWindow
      chat={withMarks(chat)}
      on={on}
      index={index}
      onClose={() => void finishChat(chat, workspace, t).catch(failed(t, t("ai.end")))}
      onDock={() => {
        unfloat(chat.id);
        dockChat(workspace, chat.id, chat.title);
      }}
    />
  );
}

export function dockChat(workspace: WorkspaceApi, id: string, title: string) {
  workspace.open({ contentId: id, title, component: CHAT_PANEL });
}

export function ChatWindows({ workspace }: { workspace: WorkspaceApi | null }) {
  const list = useFloating();
  const chats = useChats();
  if (!workspace) return null;
  return (
    <>
      {list.flatMap((id, i) => {
        const chat = chats.find((c) => c.id === id);
        return chat
          ? [
              <FloatingChat
                key={id}
                chat={chat}
                index={list.length - 1 - i}
                workspace={workspace}
              />,
            ]
          : [];
      })}
    </>
  );
}

/** Starts a chat in a window, saying the first thing if there is one. */
export async function askInWindow(s: ChatStart, first?: string): Promise<string> {
  const id = await startChat(s);
  floatChat(id);
  if (first) void sendChat(id, first);
  return id;
}

export function ProposalsPanel({ workspace }: PanelProps) {
  const t = useT();
  const { store, items } = useProposals();
  const pending = items.filter((p) => p.state === "pending");
  const done = items.filter((p) => p.state !== "pending").slice(0, 30);
  return (
    <div className="dem-flow" data-focus-home="page" tabIndex={-1}>
      <header className="dem-flow-head dem-flow-head-row">
        <h1>{t("ai.proposals")}</h1>
        {pending.length > 1 && (
          <Button size="sm" onPress={() => store.confirmAll()}>
            {t("ai.proposals.confirmAll")}
          </Button>
        )}
      </header>
      <div className="dem-flow-body">
        {!pending.length && <EmptyState icon="proposal" title={t("ai.proposals.none")} />}
        {pending.map((p) => (
          <ProposalCard
            key={p.id}
            id={p.id}
            onOpen={(id) => openById(workspace, t, id, { kind: "temp" })}
          />
        ))}
        {done.length > 0 && <h3 className="dem-nav-group">{t("ai.proposals.done")}</h3>}
        {done.map((p) => (
          <ProposalCard
            key={p.id}
            id={p.id}
            onOpen={(id) => openById(workspace, t, id, { kind: "temp" })}
          />
        ))}
      </div>
    </div>
  );
}

export function ProposalsWidget({ workspace }: PanelProps) {
  const t = useT();
  const { items } = useProposals();
  const pending = items.filter((p) => p.state === "pending");
  if (!pending.length) return <p className="dem-widget-empty">{t("ai.proposals.none")}</p>;
  return (
    <ul className="dem-widget-list">
      {pending.slice(0, 6).map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className="dem-widget-row"
            onClick={() =>
              workspace.open({
                contentId: PROPOSALS_PANEL,
                title: t("ai.proposals"),
                component: PROPOSALS_PANEL,
              })
            }
          >
            <span className="dem-widget-row-title">{p.summary || p.target.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function HarvestPanel({ params, tabId, workspace }: PanelProps) {
  const t = useT();
  const chat = String(params.chat ?? "");
  const entry = harvests.get(chat);
  const [created, setCreated] = useState<ItemView[]>([]);
  const cards = useMemo(() => cardIndex(cardKey), []);
  if (!entry) return <EmptyState icon="check" title={t("ai.chat.ended")} />;
  const finish = (summary: string, loose: string[]) => {
    harvests.delete(chat);
    void endChat(chat, summary, loose).catch(failed(t, t("ai.end")));
  };
  return (
    <HarvestSheet
      harvest={entry.harvest}
      cards={cards}
      onSave={(plan) => {
        void saveHarvest(plan, entry.container)
          .then((r) => {
            setCreated(r.created);
            showToast({ text: t("harvest.savedToast", { n: planSize(plan) }), tone: "ok" });
            finish(
              entry.harvest.summary,
              plan.loose.map((l) => l.text),
            );
          })
          .catch(failed(t, t("harvest.tab")));
      }}
      onUndo={() => {
        void Promise.all(created.map((i) => api.itemUpdate(i.id, { state: "trashed" } as never)))
          .then(() => itemsChanged())
          .catch(failed(t, t("ai.undo")));
      }}
      onDiscard={() => {
        finish(entry.harvest.summary, []);
        workspace.close(tabId);
      }}
      onOpen={(id) => openById(workspace, t, id, { kind: "temp" })}
    />
  );
}

/** The chats kept from before, and where to start a new one. */
export function AiView({ workspace }: { workspace: WorkspaceApi }) {
  const t = useT();
  const chats = useChats();
  const { items } = useProposals();
  const pending = items.filter((p) => p.state === "pending").length;
  const { data: past } = useLive<ItemView[]>(
    () =>
      api.itemList({
        typeId: "ai_session",
        states: ["active"],
        container: null,
        tag: null,
        order: "updated",
        limit: 50,
      }),
    [],
  );
  return (
    <div className="dem-nav">
      <div className="dem-nav-tools dem-nav-tools-wrap">
        <Button
          size="sm"
          variant="primary"
          icon="ai"
          onPress={() =>
            void startChat({ session: "plain", mode: "chat", title: t("ai.chat.new") })
              .then((id) => dockChat(workspace, id, t("ai.chat.new")))
              .catch(failed(t, t("ai.chat.new")))
          }
        >
          {t("ai.chat.new")}
        </Button>
        <Button
          size="sm"
          icon="proposal"
          onPress={() =>
            workspace.open({
              contentId: PROPOSALS_PANEL,
              title: t("ai.proposals"),
              component: PROPOSALS_PANEL,
            })
          }
        >
          {pending ? t("ai.proposals.count", { n: pending }) : t("ai.proposals")}
        </Button>
        <Button
          size="sm"
          icon="search"
          onPress={() =>
            workspace.open({
              contentId: AI_SEE_PANEL,
              title: t("aiSee.title"),
              component: AI_SEE_PANEL,
            })
          }
        >
          {t("aiSee.title")}
        </Button>
      </div>
      {chats.length > 0 && <h3 className="dem-nav-group">{t("ai.chat.open")}</h3>}
      <ul className="dem-nav-list">
        {chats.map((c) => (
          <li key={c.id} className="dem-nav-row">
            <button
              type="button"
              className="dem-nav-open"
              onClick={() => dockChat(workspace, c.id, c.title)}
            >
              <span className="dem-nav-title">{c.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {past.length > 0 && <h3 className="dem-nav-group">{t("ai.chat.past")}</h3>}
      <ul className="dem-nav-list">
        {past.map((p) => (
          <li key={p.id} className="dem-nav-row">
            <button
              type="button"
              className="dem-nav-open"
              title={String(parseFields(p.fields).summary ?? "")}
              onClick={() => openItem(workspace, t, p)}
            >
              <span className="dem-nav-title">{titleOf(t, p)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>{chats.some((c) => c.running) && <Spinner label={t("ai.running")} />}</div>
    </div>
  );
}
