import { describe, expect, it } from "vitest";
import {
  hasAnswered,
  isOverconfident,
  nextRound,
  peek,
  rate,
  ratingsFor,
  show,
  startReview,
  undoRate,
  type ReviewCard,
  type ReviewState,
} from "./review";

const cards: ReviewCard[] = ["a", "b", "c"].map((id) => ({ id, front: id, back: id }));
const start = () => startReview(cards, 0);
const sure = (s: ReviewState): ReviewState => ({ ...s, confidence: 3 });

describe("记忆卡复习", () => {
  it("does not show the answer before you have answered", () => {
    const s = start();
    expect(show(s).phase).toBe("answer");
    expect(show(sure(s)).phase).toBe("rate");
    expect(show({ ...s, typed: "我的答案" }).phase).toBe("rate");
    expect(show({ ...s, typed: "   " }).phase).toBe("answer");
  });

  it("records a peek, and holds it to 忘了 or 难", () => {
    const s = peek(start());
    expect(s).toMatchObject({ phase: "rate", peeked: true });
    expect(ratingsFor(true)).toEqual(["again", "hard"]);
    expect(rate(s, "good", 10)).toBe(s);
    expect(rate(s, "easy", 10)).toBe(s);
    const after = rate(s, "hard", 10);
    expect(after.log[0]).toMatchObject({ card: "a", rating: "hard", peeked: true });
  });

  it("does not count looking after answering as a peek", () => {
    expect(peek(sure(start())).peeked).toBe(false);
    expect(show(sure(start())).peeked).toBe(false);
  });

  it("logs what the review log keeps, and moves on with a clean slate", () => {
    const s = rate(show(sure(start())), "good", 1500);
    expect(s.log[0]).toEqual({
      card: "a",
      rating: "good",
      confidence: 3,
      peeked: false,
      durationMs: 1500,
      context: "card",
    });
    expect(s).toMatchObject({ at: 1, phase: "answer", confidence: null, typed: "" });
    expect(hasAnswered(s)).toBe(false);
  });

  it("ends after the last card", () => {
    let s = start();
    for (let i = 0; i < 3; i++) s = rate(show(sure(s)), "good", i);
    expect(s.phase).toBe("done");
  });

  it("calls only sure-and-forgot overconfident", () => {
    expect(isOverconfident({ confidence: 3, rating: "again" })).toBe(true);
    expect(isOverconfident({ confidence: 3, rating: "hard" })).toBe(false);
    expect(isOverconfident({ confidence: 2, rating: "again" })).toBe(false);
    expect(isOverconfident({ confidence: null, rating: "again" })).toBe(false);
  });

  it("puts sure-and-wrong cards first in the next round", () => {
    let s = start();
    s = rate(show({ ...s, confidence: 1 }), "again", 1); // a: forgot, and knew it
    s = rate(show({ ...s, confidence: 3 }), "good", 2); // b: fine
    s = rate(show({ ...s, confidence: 3 }), "again", 3); // c: sure, and wrong
    expect(nextRound(s).map((c) => c.id)).toEqual(["c", "a"]);
  });

  it("takes a rating back", () => {
    const s = rate(show(sure(start())), "again", 5);
    const back = undoRate(s, 6);
    expect(back).toMatchObject({ at: 0, phase: "rate", confidence: 3, log: [] });
    expect(undoRate(start(), 1).at).toBe(0);
  });
});
