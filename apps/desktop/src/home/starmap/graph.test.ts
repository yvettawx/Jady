import { describe, expect, it } from "vitest";
import { clusterCentres, createLayout, neighbours, settle, type StarGraph } from "./graph";

function twoClusters(): StarGraph {
  const nodes = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, title: `A ${i}`, cluster: "a" })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, title: `B ${i}`, cluster: "b" })),
  ];
  const edges: [string, string][] = [];
  for (let i = 1; i < 12; i++) edges.push(["a0", `a${i}`], ["b0", `b${i}`]);
  return {
    clusters: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    nodes,
    edges,
  };
}

describe("star map layout", () => {
  it("pulls linked items together and pushes clusters apart", () => {
    const l = createLayout(twoClusters());
    settle(l);
    const [a, b] = clusterCentres(l, 2);
    if (!a || !b) throw new Error("no centres");
    const apart = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(apart).toBeGreaterThan(a.r + b.r);
    expect(a.count).toBe(12);
  });

  it("is the same shape every time for the same graph", () => {
    const one = createLayout(twoClusters()),
      two = createLayout(twoClusters());
    settle(one, 50);
    settle(two, 50);
    expect(one.bodies.map((b) => b.x)).toEqual(two.bodies.map((b) => b.x));
  });

  it("finds linked neighbours and ignores links to unknown items", () => {
    const g = twoClusters();
    g.edges.push(["a1", "nowhere"]);
    const l = createLayout(g);
    expect(neighbours(l, 0).size).toBe(11);
    expect(l.links).toHaveLength(22);
  });
});
