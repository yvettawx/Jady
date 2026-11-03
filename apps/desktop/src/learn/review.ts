// 记忆卡复习 (PRD C2, docs/03-modules.md 复习排期): answer first, then look. You may peek, but it
// is recorded and the round then counts as 忘了 or 难 at best. Being sure and wrong is the mistake
// worth catching, so those cards lead the next round. Scheduling itself (FSRS) lives in the core.

export type Rating = "again" | "hard" | "good" | "easy";
/** 1 没把握, 2 有点把握, 3 很有把握. */
export type Confidence = 1 | 2 | 3;

export interface ReviewCard {
  id: string;
  front: string;
  back: string;
  example?: string;
}

/** One review, as the review log keeps it (format spec, M7 ReviewLog). */
export interface ReviewEntry {
  card: string;
  rating: Rating;
  confidence: Confidence | null;
  peeked: boolean;
  durationMs: number;
  /** 记忆卡复习, or used correctly in a chat. */
  context: "card" | "chat";
}

export interface ReviewState {
  queue: ReviewCard[];
  at: number;
  phase: "answer" | "rate" | "done";
  confidence: Confidence | null;
  typed: string;
  peeked: boolean;
  startedAt: number;
  log: ReviewEntry[];
}

export function startReview(queue: ReviewCard[], now: number): ReviewState {
  return {
    queue,
    at: 0,
    phase: queue.length ? "answer" : "done",
    confidence: null,
    typed: "",
    peeked: false,
    startedAt: now,
    log: [],
  };
}

/** Saying how sure you are, or writing an answer, counts as having answered. */
export const hasAnswered = (s: ReviewState) => s.confidence !== null || s.typed.trim() !== "";

/** 看答案 once you have answered; before that, the only way to see it is 偷看. */
export function show(s: ReviewState): ReviewState {
  if (s.phase !== "answer" || !hasAnswered(s)) return s;
  return { ...s, phase: "rate" };
}
export function peek(s: ReviewState): ReviewState {
  if (s.phase !== "answer" || hasAnswered(s)) return s;
  return { ...s, phase: "rate", peeked: true };
}

/** A peek counts as 忘了 or 难 at best. */
export const ratingsFor = (peeked: boolean): Rating[] =>
  peeked ? ["again", "hard"] : ["again", "hard", "good", "easy"];

export function rate(s: ReviewState, rating: Rating, now: number): ReviewState {
  const card = s.queue[s.at];
  if (s.phase !== "rate" || !card || !ratingsFor(s.peeked).includes(rating)) return s;
  const log: ReviewEntry[] = [
    ...s.log,
    {
      card: card.id,
      rating,
      confidence: s.confidence,
      peeked: s.peeked,
      durationMs: now - s.startedAt,
      context: "card",
    },
  ];
  const at = s.at + 1;
  return {
    ...s,
    at,
    log,
    phase: at < s.queue.length ? "answer" : "done",
    confidence: null,
    typed: "",
    peeked: false,
    startedAt: now,
  };
}

/** Takes the last rating back and returns to that card's answer, so a slip of the key is cheap. */
export function undoRate(s: ReviewState, now: number): ReviewState {
  const last = s.log[s.log.length - 1];
  if (!last) return s;
  return {
    ...s,
    at: s.at - 1,
    log: s.log.slice(0, -1),
    phase: "rate",
    confidence: last.confidence,
    typed: "",
    peeked: last.peeked,
    startedAt: now,
  };
}

/** 自以为会但答错: very sure beforehand, and it came out 忘了. */
export const isOverconfident = (e: Pick<ReviewEntry, "confidence" | "rating">) =>
  e.confidence === 3 && e.rating === "again";

/** What to go through again: the sure-and-wrong first, then the rest that were forgotten. */
export function nextRound(s: ReviewState): ReviewCard[] {
  const again = s.log.filter((e) => e.rating === "again");
  const ordered = [...again.filter(isOverconfident), ...again.filter((e) => !isOverconfident(e))];
  return ordered.flatMap((e) => s.queue.find((c) => c.id === e.card) ?? []);
}
