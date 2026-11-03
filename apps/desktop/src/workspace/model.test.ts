import { describe, expect, it } from "vitest";
import { layoutProblem, readLayout, type Layout } from "./layout";
import { moveOpen, orderOpen, type OpenEntry } from "./openOrder";

const SIDE = { size: 0.2, cells: [{ size: 1, tabs: ["a"] }] };
const tab = (id: string) => ({
  id,
  contentId: id,
  component: "note",
  title: id,
  kind: "temp" as const,
});
const LAYOUT: Layout = {
  version: 1,
  columns: [
    { size: 0.2, cells: [{ size: 1, tabs: ["a"] }] },
    {
      size: 0.8,
      cells: [
        { size: 0.5, tabs: ["b", "c"], active: "c" },
        { size: 0.5, tabs: ["d"] },
      ],
    },
  ],
  floating: [],
  tabs: { a: tab("a"), b: tab("b"), c: tab("c"), d: tab("d") },
};

describe("layout format", () => {
  it("accepts a well-formed layout", () => {
    expect(layoutProblem(LAYOUT)).toBeNull();
    expect(readLayout(JSON.parse(JSON.stringify(LAYOUT)))).toEqual(LAYOUT);
  });

  it("rejects a fourth column, a fourth cell, unknown versions and dangling tabs", () => {
    const col = SIDE;
    expect(layoutProblem({ ...LAYOUT, columns: [col, col, col, col] })).toMatch(/4 columns/);
    const cell = { size: 0.25, tabs: ["a"] };
    expect(
      layoutProblem({ ...LAYOUT, columns: [{ size: 1, cells: [cell, cell, cell, cell] }] }),
    ).toMatch(/4 cells/);
    expect(readLayout({ ...LAYOUT, version: 2 })).toBeNull();
    expect(layoutProblem({ ...LAYOUT, tabs: { a: tab("a") } })).toMatch(/has no entry/);
    expect(readLayout("nonsense")).toBeNull();
  });
});

describe("打开的内容 order", () => {
  const E: OpenEntry[] = [
    { id: "home", pinned: true, openedAt: 1 },
    { id: "inbox", pinned: true, openedAt: 2 },
    { id: "l11", pinned: false, openedAt: 3 },
    { id: "l12", pinned: false, openedAt: 4 },
    { id: "draft", pinned: false, openedAt: 5 },
  ];

  it("puts pinned first, then temporary tabs newest first", () => {
    expect(orderOpen(E, null)).toEqual(["inbox", "home", "draft", "l12", "l11"]);
  });

  it("keeps a dragged order and puts new temporary tabs at the top of their section", () => {
    const manual = moveOpen(E, null, "l11", "draft", "before");
    expect(manual).toEqual(["inbox", "home", "l11", "draft", "l12"]);
    const more = [...E, { id: "new", pinned: false, openedAt: 9 }];
    expect(orderOpen(more, manual)).toEqual(["inbox", "home", "new", "l11", "draft", "l12"]);
  });

  it("never moves an entry across the pinned and temporary sections", () => {
    expect(moveOpen(E, null, "draft", "home", "after")).toBeNull();
    expect(moveOpen(E, null, "home", "inbox", "before")).toEqual([
      "home",
      "inbox",
      "draft",
      "l12",
      "l11",
    ]);
  });

  it("drops closed tabs from the manual order", () => {
    const manual = ["inbox", "home", "l11", "draft", "l12"];
    expect(
      orderOpen(
        E.filter((e) => e.id !== "draft"),
        manual,
      ),
    ).toEqual(["inbox", "home", "l11", "l12"]);
  });
});

describe("conversion to and from dockview", () => {
  it("round-trips our layout", async () => {
    const { toDockview, fromDockview } = await import("./convert");
    const withFloat: Layout = {
      ...LAYOUT,
      floating: [{ tabs: ["d"], x: 40, y: 50, w: 300, h: 200 }],
      columns: [SIDE, { size: 0.8, cells: [{ size: 1, tabs: ["b", "c"], active: "c" }] }],
    };
    const dv = toDockview(withFloat, 1000, 800);
    expect(dv.grid.root.type).toBe("branch");
    const back = fromDockview(dv);
    expect(back.columns.map((c) => c.cells.map((x) => x.tabs))).toEqual([[["a"]], [["b", "c"]]]);
    expect(back.columns[1]?.cells[0]?.active).toBe("c");
    expect(back.columns.map((c) => c.size)).toEqual([0.2, 0.8]);
    expect(back.floating).toEqual([{ tabs: ["d"], active: "d", x: 40, y: 50, w: 300, h: 200 }]);
    expect(back.tabs).toEqual(withFloat.tabs);
  });
});
