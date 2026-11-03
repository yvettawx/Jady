import { describe, expect, it } from "vitest";
import { monthlySums, streakOf } from "./sums";

const row = (fields: object) => ({ fields: JSON.stringify(fields) });
const shape = { date: "date", number: "amount" };

describe("monthly sums", () => {
  it("adds up by month and part, newest first, and skips what has no date", () => {
    const got = monthlySums(
      [
        row({ date: "2026-10-03", amount: 10, category: "food" }),
        row({ date: "2026-10-20", amount: 5, category: "fun" }),
        row({ date: "2026-11-01", amount: 7, category: "food" }),
        row({ amount: 99 }),
      ],
      shape,
      "category",
    );
    expect(got.map((r) => [r.month, r.total])).toEqual([
      ["2026-11", 7],
      ["2026-10", 15],
    ]);
    expect(got[1]?.parts.get("fun")).toBe(5);
  });

  it("can keep to one kind", () => {
    const got = monthlySums(
      [
        row({ date: "2026-10-03", amount: 10, direction: "expense" }),
        row({ date: "2026-10-04", amount: 100, direction: "income" }),
      ],
      shape,
      null,
      { key: "direction", value: "expense" },
    );
    expect(got[0]?.total).toBe(10);
  });
});

describe("streak", () => {
  it("counts back from today", () => {
    expect(streakOf(["2026-11-02", "2026-11-01", "2026-10-31"], "2026-11-02")).toBe(3);
  });
  it("does not break while today is still open", () => {
    expect(streakOf(["2026-11-01", "2026-10-31"], "2026-11-02")).toBe(2);
  });
  it("stops at a gap, across month ends", () => {
    expect(streakOf(["2026-11-01", "2026-10-30"], "2026-11-01")).toBe(1);
    expect(streakOf([], "2026-11-01")).toBe(0);
  });
});
