// The star map's data and layout (docs/05-design.md §8): items gather into clusters by their
// links with a force-directed layout in 3D. Pure code, no three.js, so it is testable and the
// core can feed it later from the restricted item index.

export interface StarCluster {
  id: string;
  name: string;
  /** 私密 clusters show neither name nor titles, only that they are private. */
  private?: boolean;
}

export interface StarNode {
  id: string;
  title: string;
  /** Cluster id; undefined for loose items (收集箱). */
  cluster?: string;
  /** The cluster's main item (领域 or project), drawn larger. */
  hub?: boolean;
}

export interface StarGraph {
  clusters: StarCluster[];
  nodes: StarNode[];
  edges: [string, string][];
}

/** A node with its place and speed in the simulation. */
export interface Body {
  node: StarNode;
  /** Index into clusters, -1 when loose. */
  c: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  degree: number;
}

export interface Layout {
  bodies: Body[];
  /** Index pairs into bodies. */
  links: [number, number][];
  /** 1 at the start, cools towards 0.03 as the layout settles. */
  alpha: number;
}

/** A small seeded generator, so the same graph always settles into the same shape. */
export function seeded(seed = 7): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function createLayout(g: StarGraph, rnd = seeded()): Layout {
  const ci = new Map(g.clusters.map((c, i) => [c.id, i]));
  const bodies: Body[] = g.nodes.map((node) => {
    const r = 24 * Math.cbrt(rnd()),
      th = rnd() * Math.PI * 2,
      ph = Math.acos(2 * rnd() - 1);
    return {
      node,
      c: node.cluster === undefined ? -1 : (ci.get(node.cluster) ?? -1),
      x: r * Math.sin(ph) * Math.cos(th),
      y: r * Math.cos(ph) * 0.6,
      z: r * Math.sin(ph) * Math.sin(th),
      vx: 0,
      vy: 0,
      vz: 0,
      degree: 0,
    };
  });
  const at = new Map(g.nodes.map((n, i) => [n.id, i]));
  const links: [number, number][] = [];
  for (const [a, b] of g.edges) {
    const i = at.get(a),
      j = at.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    links.push([i, j]);
    (bodies[i] as Body).degree++;
    (bodies[j] as Body).degree++;
  }
  return { bodies, links, alpha: 1 };
}

/**
 * One step: every pair repels (more across clusters, so clusters separate), links pull like
 * springs, and a weak pull to the centre keeps everything in view, flattened vertically.
 */
export function step(l: Layout): void {
  const { bodies, links } = l;
  const kr = 3.2,
    ks = 0.11,
    rest = 1.1;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i] as Body;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j] as Body;
      let dx = a.x - b.x,
        dy = a.y - b.y,
        dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz + 0.01;
      if (d2 > 1200) continue;
      const f = (a.c === b.c ? kr : kr * 2.4) / d2,
        d = Math.sqrt(d2);
      dx /= d;
      dy /= d;
      dz /= d;
      a.vx += dx * f;
      a.vy += dy * f;
      a.vz += dz * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
      b.vz -= dz * f;
    }
  }
  for (const [i, j] of links) {
    const a = bodies[i] as Body,
      b = bodies[j] as Body;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      dz = b.z - a.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001,
      f = ((d - rest) * ks) / d;
    a.vx += dx * f;
    a.vy += dy * f;
    a.vz += dz * f;
    b.vx -= dx * f;
    b.vy -= dy * f;
    b.vz -= dz * f;
  }
  for (const n of bodies) {
    const g = n.c < 0 ? 0.006 : 0.022;
    n.vx -= n.x * g;
    n.vy -= n.y * g * 1.6;
    n.vz -= n.z * g;
    n.vx *= 0.78;
    n.vy *= 0.78;
    n.vz *= 0.78;
    n.x += n.vx * l.alpha;
    n.y += n.vy * l.alpha;
    n.z += n.vz * l.alpha;
  }
  l.alpha = Math.max(0.03, l.alpha * 0.988);
}

/** Runs the layout until it has settled (reduced motion shows the end state at once). */
export function settle(l: Layout, steps = 320): void {
  for (let i = 0; i < steps; i++) step(l);
}

export interface ClusterCentre {
  x: number;
  y: number;
  z: number;
  /** Mean distance of its items from the centre. */
  r: number;
  count: number;
}

export function clusterCentres(l: Layout, clusters: number): ClusterCentre[] {
  const out = Array.from({ length: clusters }, () => ({ x: 0, y: 0, z: 0, r: 0, count: 0 }));
  for (const b of l.bodies) {
    const c = out[b.c];
    if (!c) continue;
    c.x += b.x;
    c.y += b.y;
    c.z += b.z;
    c.count++;
  }
  for (const c of out) {
    if (!c.count) continue;
    c.x /= c.count;
    c.y /= c.count;
    c.z /= c.count;
  }
  for (const b of l.bodies) {
    const c = out[b.c];
    if (c) c.r += Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z) / c.count;
  }
  return out;
}

/** Indices of the bodies linked to one body. */
export function neighbours(l: Layout, i: number): Set<number> {
  const s = new Set<number>();
  for (const [a, b] of l.links) {
    if (a === i) s.add(b);
    if (b === i) s.add(a);
  }
  return s;
}
