// An AI chat as a small floating window (docs/05-design.md §5.3): several can be open and none
// blocks anything. Drag the head to move it; it can go into the workspace as a panel.
import { useRef, useState } from "react";
import { useT } from "../i18n/context";
import { Button } from "../ui/Button";
import { Glass } from "../ui/glass/Glass";
import { Icon } from "../ui/Icon";
import { ChatView } from "./ChatView";
import { SessionMarks } from "./SessionMarks";
import type { Chat, ChatHandlers } from "./types";
import "./chat.css";

export function ChatWindow({
  chat,
  on,
  index,
  onClose,
  onDock,
}: {
  chat: Chat;
  on: ChatHandlers;
  /** Which open window this is: each starts a little further along, so none hides another. */
  index: number;
  onClose: () => void;
  onDock: () => void;
}) {
  const t = useT();
  const [at, setAt] = useState({ x: 0, y: 0 });
  const drag = useRef<null | { x: number; y: number; ox: number; oy: number }>(null);
  return (
    <Glass
      refract={false}
      className="dem-chat-window"
      role="dialog"
      aria-label={chat.title}
      style={{
        transform: `translate(${at.x - index * 28}px, ${at.y - index * 28}px)`,
      }}
      onKeyDown={(e) => {
        const box = e.target as HTMLElement;
        const empty = box.tagName !== "TEXTAREA" || !(box as HTMLTextAreaElement).value;
        if (e.key === "Escape" && empty) onClose();
      }}
    >
      <header
        className="dem-chat-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: at.x, oy: at.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setAt({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <Icon name="ai" size={14} />
        <span className="dem-chat-title">{chat.title}</span>
        <SessionMarks session={chat.session} />
        <span className="dem-chat-gap" />
        <Button variant="quiet" size="sm" icon="dock" aria-label={t("ai.dock")} onPress={onDock} />
        <Button
          variant="quiet"
          size="sm"
          icon="close"
          aria-label={t("action.close")}
          onPress={onClose}
        />
      </header>
      <ChatView chat={chat} on={on} autoFocus />
    </Glass>
  );
}
