import { describe, expect, it } from "vitest";
import { cardKey, planHarvest, planSize, type Harvest } from "./harvest";

const word = (id: string, w: string) => ({ id, word: w, meaning: "", example: "" });
const harvest: Harvest = {
  summary: "",
  words: [word("w1", "le quai"), word("w2", "la voie"), word("w3", "Le Quai")],
  grammar: [{ id: "g1", title: "", note: "" }],
  mistakes: [{ id: "m1", wrong: "", right: "", why: "" }],
  loose: [{ id: "l1", text: "" }],
};

describe("本次收获", () => {
  it("only adds an example to a word that already has a card", () => {
    const plan = planHarvest(harvest, new Set(), new Map([["voie", "card-9"]]));
    expect(plan.examples.map((e) => e.card)).toEqual(["card-9"]);
    expect(plan.newCards.map((w) => w.id)).not.toContain("w2");
  });

  it("makes one card for a word that turned up twice", () => {
    const plan = planHarvest(harvest, new Set(), new Map());
    expect(plan.newCards.map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("saves nothing that was unticked", () => {
    const plan = planHarvest(harvest, new Set(["w1", "w3", "g1", "m1", "l1"]), new Map());
    expect(plan.newCards.map((w) => w.id)).toEqual(["w2"]);
    expect(plan.grammar).toEqual([]);
    expect(plan.mistakes).toEqual([]);
    expect(plan.loose).toEqual([]);
    expect(planSize(plan)).toBe(1);
  });

  it("ignores articles and case when matching cards, and keeps accents", () => {
    expect(cardKey(" Le Quai ")).toBe("quai");
    expect(cardKey("l'horaire")).toBe("horaire");
    expect(cardKey("être")).not.toBe(cardKey("etre"));
  });
});
