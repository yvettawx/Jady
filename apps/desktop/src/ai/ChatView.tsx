// The inside of an AI chat, the same floating or in a workspace cell (docs/05-design.md §5.1,
// §5.3). Talk has no frame; something generated is a sheet you place; a proposal shows what would
// change and takes effect only when you confirm it (ProposalCard).
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/context";
import { ProtectedLink } from "../privacy/ProtectedLink";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { ProposalCard } from "./ProposalCard";
import { SourceLine } from "./SourceMarks";
import type { Chat, ChatHandlers, ChatMessage, ChatPart } from "./types";
import "./chat.css";

function Parts({ parts, onOpen }: { parts: ChatPart[]; onOpen: (id: string) => void }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : p.kind === "protected" ? (
          <ProtectedLink key={i} />
        ) : (
          <a
            key={i}
            className="dem-wikilink"
            href={`#item:${p.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen(p.id);
            }}
          >
            {p.title}
          </a>
        ),
      )}
    </>
  );
}

function Message({ m, on }: { m: ChatMessage; on: ChatHandlers }) {
  const t = useT();
  if (m.kind === "me") return <p className="dem-chat-me">{m.text}</p>;
  if (m.kind === "say")
    return (
      <div>
        <p className="dem-chat-say">
          <Parts parts={m.parts} onOpen={on.onOpen} />
        </p>
        {m.source && <SourceLine source={m.source} />}
      </div>
    );
  if (m.kind === "generated")
    return (
      <article
        className="dem-chat-gen"
        data-testid="chat-generated"
        data-focus-home="card"
        tabIndex={-1}
      >
        <h4>{m.title}</h4>
        <p>{m.text}</p>
        {m.source && <SourceLine source={m.source} />}
        <footer>
          {m.placed ? (
            <>
              <span className="dem-chat-done">
                <Icon name="check" size={12} />
                {t(m.placed === "insert" ? "ai.gen.inserted" : "ai.gen.saved")}
              </span>
              <Button size="sm" variant="quiet" icon="undo" onPress={() => on.onUnplace(m.id)}>
                {t("ai.undo")}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onPress={() => on.onPlace(m.id, "insert")}>
                {t("ai.gen.insert")}
              </Button>
              <Button size="sm" variant="quiet" onPress={() => on.onPlace(m.id, "save")}>
                {t("ai.gen.save")}
              </Button>
            </>
          )}
        </footer>
      </article>
    );
  return <ProposalCard id={m.proposal} onOpen={on.onOpen} />;
}

export function ChatView({
  chat,
  on,
  autoFocus,
}: {
  chat: Chat;
  on: ChatHandlers;
  autoFocus?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  // Follows what is coming in, unless you have scrolled back to read.
  const count = chat.messages.length;
  const lastSize = JSON.stringify(chat.messages[count - 1] ?? "").length;
  useEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120)
      el.scrollTop = el.scrollHeight;
  }, [count, lastSize]);
  const send = () => {
    if (!text.trim() || chat.running) return;
    on.onSend(text.trim());
    setText("");
  };
  return (
    <div className="dem-chat">
      <div ref={list} className="dem-chat-list" role="log" aria-label={chat.title}>
        {chat.quote && <blockquote className="dem-chat-quote">{chat.quote}</blockquote>}
        {chat.messages.map((m) => (
          <Message key={m.id} m={m} on={on} />
        ))}
        {chat.running && <p className="dem-chat-thinking">{t("ai.running")}</p>}
      </div>
      <div className="dem-chat-compose">
        <textarea
          ref={input}
          rows={1}
          aria-label={t("ai.input")}
          placeholder={t("ai.input")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter while an input method composes picks characters; it sends nothing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {chat.running ? (
          <Button size="sm" onPress={on.onStop}>
            {t("ai.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" isDisabled={!text.trim()} onPress={send}>
            {t("ai.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
