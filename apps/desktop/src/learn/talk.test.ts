import { describe, expect, it } from "vitest";
import { chatReview, mentions, reviewedBy } from "./talk";

const due = [
  { id: "quai", word: "le quai" },
  { id: "guichet", word: "le guichet" },
];

describe("法语实时对话", () => {
  it("matches whole words, whatever the article or case", () => {
    expect(mentions("Le train part de quel quai ?", "le quai")).toBe(true);
    expect(mentions("QUAI numéro deux", "le quai")).toBe(true);
    expect(mentions("Les quais sont loin", "le quai")).toBe(false);
    expect(mentions("Il est à l'école", "l'école")).toBe(true);
  });

  it("counts a word you used correctly", () => {
    const hits = reviewedBy("Où est le guichet ?", due, new Set(), []);
    expect(hits.map((d) => d.id)).toEqual(["guichet"]);
  });

  it("does not count a word that was the mistake", () => {
    const hits = reviewedBy("Où est la guichet ?", due, new Set(), [{ wrong: "la guichet" }]);
    expect(hits).toEqual([]);
  });

  it("still counts another word in a message with a mistake elsewhere", () => {
    const hits = reviewedBy("J'ai allé au quai.", due, new Set(), [{ wrong: "J'ai allé" }]);
    expect(hits.map((d) => d.id)).toEqual(["quai"]);
  });

  it("counts each word once in a chat", () => {
    expect(reviewedBy("le quai", due, new Set(["quai"]), [])).toEqual([]);
  });

  it("records it as a review made in a chat", () => {
    expect(chatReview({ id: "quai", word: "le quai" }, 900)).toEqual({
      card: "quai",
      rating: "good",
      confidence: null,
      peeked: false,
      durationMs: 900,
      context: "chat",
    });
  });
});
