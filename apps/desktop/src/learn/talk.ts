// 法语实时对话 (PRD C6 and the worked example in §2): the words due today come up in the chat, and
// using one correctly counts as reviewing it. Corrections are kept apart from the conversation.
import { cardKey } from "../ai/harvest";
import type { ReviewEntry } from "./review";

export interface DueWord {
  id: string;
  word: string;
}

export interface Correction {
  id: string;
  /** Which of your messages. */
  turn: string;
  wrong: string;
  right: string;
  why: string;
}

/** Whole words only: "quai" is in "le quai" but not in "quais" or "quaint". */
export function mentions(text: string, word: string): boolean {
  const bare = cardKey(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\p{L})${bare}(?!\\p{L})`, "iu").test(text);
}

/**
 * Which due words this message reviewed: said, and not the thing that was just corrected. Each
 * word counts once in a chat.
 */
export function reviewedBy(
  text: string,
  due: readonly DueWord[],
  done: ReadonlySet<string>,
  corrections: readonly Pick<Correction, "wrong">[],
): DueWord[] {
  return due.filter(
    (d) =>
      !done.has(d.id) &&
      mentions(text, d.word) &&
      !corrections.some((c) => mentions(c.wrong, d.word)),
  );
}

/** The review log's entry for a word used in passing: no confidence asked, nothing to peek at. */
export const chatReview = (word: DueWord, durationMs: number): ReviewEntry => ({
  card: word.id,
  rating: "good",
  confidence: null,
  peeked: false,
  durationMs,
  context: "chat",
});
