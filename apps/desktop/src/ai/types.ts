// What an AI chat holds (docs/05-design.md §5.1). Three things AI does look different on purpose:
// it talks (say), it makes something new that you place (generated), it wants to change something
// that exists (proposal).
import type { AiLink, AiSession } from "../privacy/policy";
import type { SourceInfo } from "./source";

/** Text, or a link that has been through aiLink: what AI cannot read has no title here. */
export type ChatPart = string | AiLink;

export type ChatMessage =
  | { id: string; kind: "me"; text: string }
  | { id: string; kind: "say"; parts: ChatPart[]; source?: SourceInfo }
  | {
      id: string;
      kind: "generated";
      title: string;
      text: string;
      placed?: "insert" | "save";
      source?: SourceInfo;
    }
  | { id: string; kind: "proposal"; proposal: string };

export interface Chat {
  id: string;
  title: string;
  session: AiSession;
  /** The tab it was started from. */
  tabContent?: string;
  /** What was selected when it started. */
  quote?: string;
  messages: ChatMessage[];
  running: boolean;
}

export interface ChatHandlers {
  onSend: (text: string) => void;
  onStop: () => void;
  onPlace: (messageId: string, where: "insert" | "save") => void;
  onUnplace: (messageId: string) => void;
  onOpen: (id: string) => void;
}
