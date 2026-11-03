import { describe, expect, it } from "vitest";
import {
  currentStreak,
  dayShares,
  dayTotal,
  intensityScale,
  listedItems,
  weekGrid,
  type HeatDay,
} from "./model";

const day = (date: string, counts: Record<string, number> = {}): HeatDay => ({ date, counts });

describe("heat map data", () => {
  it("leaves hidden types out of totals and shares", () => {
    const d = day("2026-11-02", { note: 3, card: 1 });
    expect(dayTotal(d)).toBe(4);
    expect(dayTotal(d, new Set(["note"]))).toBe(1);
    expect(dayShares(d, ["note", "card", "todo"])).toEqual([
      { type: "note", share: 0.75 },
      { type: "card", share: 0.25 },
    ]);
    expect(dayShares(d, ["note", "card"], new Set(["note", "card"]))).toEqual([]);
  });

  it("does not let one wild day flatten the others", () => {
    const days = [...Array.from({ length: 40 }, (_, i) => day(`d${i}`, { note: 4 }))];
    days.push(day("wild", { note: 400 }));
    const scale = intensityScale(days);
    expect(scale(days[0] as HeatDay)).toBe(1);
    expect(scale(day("x", { note: 1 }))).toBeCloseTo(0.5);
    expect(scale(day("x"))).toBe(0);
  });

  it("counts the streak back from today, and an empty today does not break it", () => {
    expect(currentStreak([day("a", { note: 1 }), day("b"), day("c", { note: 1 })])).toBe(1);
    expect(currentStreak([day("a", { note: 1 }), day("b", { note: 1 }), day("c")])).toBe(2);
    expect(currentStreak([day("a"), day("b")])).toBe(0);
  });

  it("starts weeks on Monday", () => {
    // 2026-11-01 is a Sunday, 2026-11-02 a Monday.
    expect(weekGrid([day("2026-11-01"), day("2026-11-02")])).toEqual([
      { col: 0, row: 6 },
      { col: 1, row: 0 },
    ]);
  });

  it("never lists a 机密 title on the day card", () => {
    const item = (id: string, privacy: "normal" | "sensitive" | "private" | "secret") => ({
      id,
      title: id,
      type: "note",
      privacy,
    });
    const shown = listedItems([
      item("a", "normal"),
      item("b", "sensitive"),
      item("c", "private"),
      item("d", "secret"),
    ]);
    expect(shown.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
