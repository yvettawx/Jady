import { describe, expect, it } from "vitest";
import { parseCases } from "../panels/LearnPanels";
import { layoutGraph } from "./Graph";
import { removalsFor, parseBoard } from "./Whiteboard";
import { wheelRows } from "./Wheel";
import { coordsOf } from "./WorldMap";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("balance wheel", () => {
  const node = (id: string, privacy: string, parent: string | null = null) => ({
    id,
    parent,
    kind: "domain",
    title: id,
    privacy,
  });
  it("counts recent changes under the top domain, nested projects included", () => {
    const rows = wheelRows(
      [node("lang", "normal"), { ...node("fr", "normal", "lang"), kind: "project" }],
      [
        { id: "a", container: "fr", updated: NOW - DAY, typeId: "note" },
        { id: "b", container: "lang", updated: NOW - 60 * DAY, typeId: "note" },
      ],
      NOW,
      "",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recent).toBe(1);
    expect(rows[0]?.last).toBe(NOW - DAY);
  });
  it("leaves out private domains and marks which names may go to an AI chat", () => {
    const rows = wheelRows(
      [
        node("a", "normal"),
        node("b", "sensitive"),
        node("c", "private"),
        node("d", "confidential"),
      ],
      [],
      NOW,
      "",
    );
    expect(rows.map((r) => [r.id, r.open])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

describe("relation graph layout", () => {
  it("is the same every time and stays on the page", () => {
    const ids = ["a", "b", "c", "d"];
    const edges: [string, string][] = [["a", "b"]];
    const one = layoutGraph(ids, edges);
    expect(one).toEqual(layoutGraph(ids, edges));
    for (const p of one) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(800);
    }
  });
});

describe("whiteboard", () => {
  it("tells nodes from lines and ignores what it cannot read", () => {
    const b = parseBoard({
      n: JSON.stringify({ x: 1, y: 2, w: 3, h: 4, text: "x" }),
      l: JSON.stringify({ from: "n", to: "m" }),
      bad: "{not json",
    });
    expect([...b.nodes.keys()]).toEqual(["n"]);
    expect([...b.lines.keys()]).toEqual(["l"]);
  });
  it("takes a node's lines with it", () => {
    const lines = new Map([
      ["l1", { from: "a", to: "b" }],
      ["l2", { from: "c", to: "d" }],
    ]);
    expect(removalsFor("a", lines)).toEqual({ a: null, l1: null });
  });
});

describe("test cases", () => {
  it("reads one per line, with line breaks written out", () => {
    expect(parseCases("1 2 => 3\n\nnot a case\n1\\n2 => 3\\n")).toEqual([
      { input: "1 2", expected: "3" },
      { input: "1\n2", expected: "3\n" },
    ]);
  });
});

describe("map", () => {
  const item = (f: object) => ({ fields: JSON.stringify(f) }) as never;
  it("needs both numbers, in range", () => {
    expect(coordsOf(item({ lat: 31.2, lng: 121.5 }))).toEqual([31.2, 121.5]);
    expect(coordsOf(item({ lat: 0, lng: 0 }))).toEqual([0, 0]);
    expect(coordsOf(item({ lat: 31.2 }))).toBeNull();
    expect(coordsOf(item({ lat: 95, lng: 0 }))).toBeNull();
  });
});
