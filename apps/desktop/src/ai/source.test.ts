import { describe, expect, it } from "vitest";
import { MINE, recheckDue, sourceMarks } from "./source";

describe("来源和把握", () => {
  it("shows no mark for what you wrote yourself", () => {
    expect(sourceMarks(MINE)).toEqual([]);
  });

  it("names where it came from, then what needs attention", () => {
    expect(sourceMarks({ ...MINE, origin: "aiMemory", needsCheck: true })).toEqual([
      "aiMemory",
      "unverified",
    ]);
    expect(sourceMarks({ ...MINE, origin: "aiSearch", conflict: true })).toEqual([
      "aiSearch",
      "conflict",
    ]);
  });

  it("still flags your own writing when you marked it 待查", () => {
    expect(sourceMarks({ ...MINE, needsCheck: true })).toEqual(["unverified"]);
  });

  it("is due on the day and after, never without a date", () => {
    expect(recheckDue({ ...MINE, recheckOn: "2026-11-02" }, "2026-11-02")).toBe(true);
    expect(recheckDue({ ...MINE, recheckOn: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(recheckDue({ ...MINE, recheckOn: "2026-11-03" }, "2026-11-02")).toBe(false);
    expect(recheckDue(MINE, "2026-11-02")).toBe(false);
  });
});
