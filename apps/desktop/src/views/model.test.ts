import { describe, expect, it } from "vitest";
import { applyFilter, applySort, daysUntil, moveTo, type Item, type TypeDef } from "./model";

const T: TypeDef = {
  id: "job",
  name: "职位",
  titleField: "title",
  fields: [
    { id: "title", label: "职位", kind: "text" },
    {
      id: "status",
      label: "状态",
      kind: "select",
      options: [
        { id: "want", label: "想投", tone: "neutral" },
        { id: "sent", label: "已投", tone: "accent" },
      ],
    },
    { id: "due", label: "截止", kind: "date" },
  ],
};
const items: Item[] = [
  { id: "a", values: { title: "研究助理", status: "sent", due: "2026-10-30" } },
  { id: "b", values: { title: "后端实习", status: "want", due: null } },
  { id: "c", values: { title: "Android 开发", status: "want", due: "2026-10-28" } },
];

describe("table and board model", () => {
  it("filters by text anywhere and by options", () => {
    expect(applyFilter(items, { text: "实习", options: {} }).map((x) => x.id)).toEqual(["b"]);
    expect(
      applyFilter(items, { text: "", options: { status: ["want"] } }).map((x) => x.id),
    ).toEqual(["b", "c"]);
    expect(applyFilter(items, { text: "android", options: {} }).map((x) => x.id)).toEqual(["c"]);
  });

  it("sorts selects by option order, dates by date, empty last either way", () => {
    expect(
      applySort(items, T, { field: "status", direction: "ascending" }).map((x) => x.id),
    ).toEqual(["b", "c", "a"]);
    expect(applySort(items, T, { field: "due", direction: "ascending" }).map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(applySort(items, T, { field: "due", direction: "descending" }).map((x) => x.id)).toEqual(
      ["a", "c", "b"],
    );
  });

  it("moves a card to another column, before a given card", () => {
    const m = moveTo(items, "a", "status", "want", "c");
    expect(m.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(m.find((x) => x.id === "a")?.values.status).toBe("want");
  });

  it("counts days to a date in local days", () => {
    const now = new Date(2026, 9, 26, 23, 30);
    expect(daysUntil("2026-10-26", now)).toBe(0);
    expect(daysUntil("2026-10-29", now)).toBe(3);
    expect(daysUntil("2026-10-20", now)).toBe(-6);
  });
});
