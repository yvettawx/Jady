import { describe, expect, it } from "vitest";
import { isDue } from "./scheduleRule";

const at = (s: string) => new Date(s);

describe("scheduled tasks", () => {
  it("waits for its time on the first day", () => {
    expect(isDue({ at: "09:00" }, at("2026-11-03T08:59:00"))).toBe(false);
    expect(isDue({ at: "09:00" }, at("2026-11-03T09:00:00"))).toBe(true);
  });
  it("runs once a day when daily", () => {
    const task = { frequency: "daily", at: "09:00", last_run: "2026-11-03T09:00:30" };
    expect(isDue(task, at("2026-11-03T21:00:00"))).toBe(false);
    expect(isDue(task, at("2026-11-04T08:00:00"))).toBe(false);
    expect(isDue(task, at("2026-11-04T09:00:00"))).toBe(true);
  });
  it("waits a week when weekly, and catches up once after a long gap", () => {
    const task = { frequency: "weekly", at: "09:00", last_run: "2026-11-03T09:00:30" };
    expect(isDue(task, at("2026-11-09T10:00:00"))).toBe(false);
    expect(isDue(task, at("2026-11-10T09:00:00"))).toBe(true);
    expect(isDue(task, at("2027-02-01T09:30:00"))).toBe(true);
  });
  it("does nothing while paused, and a bad time means nine o'clock", () => {
    expect(isDue({ paused: true }, at("2026-11-03T23:00:00"))).toBe(false);
    expect(isDue({ at: "soon" }, at("2026-11-03T08:00:00"))).toBe(false);
    expect(isDue({ at: "soon" }, at("2026-11-03T09:00:00"))).toBe(true);
  });
});
