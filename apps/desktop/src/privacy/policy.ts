// What each privacy level allows (PRD F1, docs/03-modules.md M9, format spec §15, 05 §5.6). The
// interface asks here instead of deciding for itself. This only shapes the interface: what AI
// can really read is enforced by the core's restricted view, whatever the interface shows.
import type { PrivacyLevel } from "../ui/Badge";

export type AiAccess = "open" | "authorized" | "blocked";
export type WebSearch = "open" | "confirm" | "blocked";

const ORDER: PrivacyLevel[] = ["normal", "sensitive", "private", "secret"];

/** 敏感: only in a session the user starts. 私密 and 机密: never. */
export function aiAccess(level: PrivacyLevel): AiAccess {
  return level === "normal" ? "open" : level === "sensitive" ? "authorized" : "blocked";
}

/** 互联网搜索 on selected text: 敏感 asks first; 私密 and 机密 are greyed. */
export function webSearch(level: PrivacyLevel): WebSearch {
  return level === "normal" ? "open" : level === "sensitive" ? "confirm" : "blocked";
}

/** Lowering asks for confirmation and says who can read it then; raising just happens. */
export const isLowering = (from: PrivacyLevel, to: PrivacyLevel) =>
  ORDER.indexOf(to) < ORDER.indexOf(from);

/**
 * 机密 titles appear only in 目录: not in search, the launcher, the star map, recently opened
 * or notifications (2026-11-02).
 */
export const listedOutsideDirectory = (level: PrivacyLevel) => level !== "secret";

/** A newly 机密 item asks again before opening, until the user turns that off. */
export const verifiesByDefault = (level: PrivacyLevel) => level === "secret";

/**
 * What kind of AI session this is (M9, CLAUDE.md). plain: 普通 content only, web on. authorized:
 * 敏感 content too, web off. webAuthorized: web on, and of 敏感 content only what the user marked
 * 可以联网给 AI 用, one item at a time.
 */
export type AiSession = "plain" | "authorized" | "webAuthorized";

export interface AiTarget {
  level: PrivacyLevel;
  /** 可以联网给 AI 用 (format spec meta.ai_web): set only by the user, only meaningful on 敏感. */
  aiWeb?: boolean;
}

/** Whether AI may see this in this session. 私密 and 机密: never, whatever the session. */
export function aiReads(target: AiTarget, session: AiSession): boolean {
  if (target.level === "normal") return true;
  if (target.level !== "sensitive") return false;
  if (session === "authorized") return true;
  return session === "webAuthorized" && target.aiWeb === true;
}

/** Only the authorised session has the web turned off. */
export const sessionHasWeb = (session: AiSession) => session !== "authorized";

/** Which sessions can be started on this: none, or the ones the user may choose between. */
export function sessionsFor(target: AiTarget): AiSession[] {
  if (target.level === "normal") return ["plain"];
  if (target.level !== "sensitive") return [];
  return target.aiWeb ? ["authorized", "webAuthorized"] : ["authorized"];
}

export type AiLink = { kind: "link"; id: string; title: string } | { kind: "protected" };

/**
 * How a link looks in what AI is shown: anything it cannot read becomes 受保护的内容, with
 * neither id nor title, the same for 不可见 and 不存在 (format spec §15).
 */
export function aiLink(
  target: { id: string; title: string; level: PrivacyLevel; aiWeb?: boolean } | null,
  session: AiSession = "plain",
): AiLink {
  if (!target || !aiReads(target, session)) return { kind: "protected" };
  return { kind: "link", id: target.id, title: target.title };
}
