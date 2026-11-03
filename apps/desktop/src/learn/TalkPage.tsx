// 实时对话 (docs/05-design.md §5.3): AI is the page itself, not a window on it. The conversation
// stays a conversation: your sentences are left as you wrote them, with no red on them, and
// corrections gather in their own column, to read when you want.
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import type { Correction, DueWord } from "./talk";
import "../ai/chat.css";
import "../editor/diff.css";
import "./talk.css";

export interface TalkTurn {
  id: string;
  who: "me" | "partner";
  text: string;
  /** 起步阶段 the partner adds a line of Chinese. */
  gloss?: string;
}

export function TalkPage({
  title,
  turns,
  corrections,
  due,
  reviewed,
  typing,
  onSend,
  onEnd,
}: {
  title: string;
  turns: TalkTurn[];
  corrections: Correction[];
  due: DueWord[];
  /** The due words already used correctly. */
  reviewed: ReadonlySet<string>;
  typing: boolean;
  onSend: (text: string) => void;
  onEnd: () => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [lit, setLit] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const started = turns.some((x) => x.who === "me");
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);
  const send = () => {
    if (!text.trim() || typing) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="dem-talk" data-focus-home="page" tabIndex={-1}>
      <header className="dem-talk-head">
        <h2>{title}</h2>
        <ul className="dem-talk-due" aria-label={t("talk.due")}>
          {due.map((d) => (
            <li key={d.id} data-done={reviewed.has(d.id) || undefined} lang="fr">
              {reviewed.has(d.id) && <Icon name="check" size={12} />}
              {d.word}
            </li>
          ))}
        </ul>
        <span className="dem-chat-gap" />
        <Button isDisabled={!started} onPress={onEnd}>
          {t("talk.end")}
        </Button>
      </header>
      <div className="dem-talk-body">
        <main className="dem-talk-main">
          <div ref={list} className="dem-talk-turns" role="log" aria-label={title}>
            {turns.map((x) => (
              <div
                key={x.id}
                className="dem-talk-turn"
                data-who={x.who}
                data-lit={lit === x.id || undefined}
              >
                <p lang="fr">{x.text}</p>
                {x.gloss && <p className="dem-talk-gloss">{x.gloss}</p>}
              </div>
            ))}
            {typing && <p className="dem-chat-thinking">{t("ai.running")}</p>}
          </div>
          <div className="dem-chat-compose dem-talk-compose">
            <textarea
              rows={1}
              lang="fr"
              aria-label={t("talk.input")}
              placeholder={t("talk.input")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button size="sm" variant="primary" isDisabled={!text.trim() || typing} onPress={send}>
              {t("ai.send")}
            </Button>
          </div>
        </main>
        <aside className="dem-talk-fixes" aria-label={t("talk.fixes")} aria-live="off">
          <h3>{t("talk.fixes")}</h3>
          {corrections.length === 0 ? (
            <p className="dem-talk-none">{t("talk.fixes.none")}</p>
          ) : (
            <ul>
              {corrections.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="dem-talk-fix"
                    onMouseEnter={() => setLit(c.turn)}
                    onMouseLeave={() => setLit(null)}
                    onFocus={() => setLit(c.turn)}
                    onBlur={() => setLit(null)}
                  >
                    <span className="dem-diff-inline" lang="fr">
                      <del>{c.wrong}</del> <ins>{c.right}</ins>
                    </span>
                    <small>{c.why}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
