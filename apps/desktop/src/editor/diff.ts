// Comparing two versions of a note (docs/05-design.md §3.5 版本对比, PRD 版本历史与对比): line up
// the paragraphs, then within a changed pair mark what was removed and added. 汉字 are compared
// one by one and Western words whole, so a changed word is marked as a word, not as letters.

export type Op = "same" | "removed" | "added";
export interface Piece {
  op: Op;
  text: string;
}
export type Row =
  | { kind: "same"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "added"; text: string }
  | { kind: "changed"; before: Piece[]; after: Piece[]; inline: Piece[] };

/** 汉字 and other CJK one by one; words with their accents together; spaces and marks apart. */
export function tokens(s: string): string[] {
  return (
    s.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}'’_-]+|\s+|[^\s]/gu,
    ) ?? []
  );
}

/** Longest common subsequence of two lists, as pairs of indices. */
function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length,
    m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as number[],
        next = dp[i + 1] as number[];
      row[j] = eq(a[i] as T, b[j] as T)
        ? (next[j + 1] as number) + 1
        : Math.max(next[j] as number, row[j + 1] as number);
    }
  const out: [number, number][] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (eq(a[i] as T, b[j] as T)) {
      out.push([i++, j++]);
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number))
      i++;
    else j++;
  }
  return out;
}

/** Adjacent pieces with the same op become one. */
function join(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.op === p.op) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/**
 * Shared bits too short to mean anything, sitting between two changes, become part of the
 * change: a lone space between "une pomme" and "deux pommes", or a single 动 that happens to
 * match inside a rewritten phrase. Then a rewrite reads as one change instead of confetti.
 */
function cleanup(ops: Piece[]): Piece[] {
  let runs = join(ops);
  for (let changed = true; changed;) {
    changed = false;
    const next: Piece[] = [];
    runs.forEach((p, k) => {
      const before = runs[k - 1],
        after = runs[k + 1];
      const short = [...p.text.trim()].length <= 2;
      if (
        p.op === "same" &&
        short &&
        before &&
        after &&
        before.op !== "same" &&
        after.op !== "same"
      ) {
        next.push({ op: "removed", text: p.text }, { op: "added", text: p.text });
        changed = true;
      } else next.push(p);
    });
    // Within a change, everything removed reads before everything added.
    runs = join(
      next.reduce<Piece[]>((acc, p) => {
        const last = acc.at(-1);
        if (p.op === "removed" && last?.op === "added") {
          let k = acc.length;
          while (k > 0 && acc[k - 1]?.op === "added") k--;
          acc.splice(k, 0, p);
        } else acc.push(p);
        return acc;
      }, []),
    );
  }
  return runs;
}

/** What changed inside one paragraph: the old text's pieces and the new text's pieces. */
export function diffText(
  before: string,
  after: string,
): { before: Piece[]; after: Piece[]; inline: Piece[] } {
  const a = tokens(before),
    b = tokens(after);
  const pairs = lcs(a, b, (x, y) => x === y);
  const ops: Piece[] = [];
  let i = 0,
    j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (i < pi) ops.push({ op: "removed", text: a[i++] as string });
    while (j < pj) ops.push({ op: "added", text: b[j++] as string });
    if (pi < a.length && pj < b.length) {
      ops.push({ op: "same", text: a[i++] as string });
      j++;
    }
  }
  const clean = cleanup(ops);
  return {
    before: join(clean.filter((p) => p.op !== "added")),
    after: join(clean.filter((p) => p.op !== "removed")),
    /** Both in one line: shared text once, each change removed-then-added in place. */
    inline: clean,
  };
}

/** How alike two paragraphs are, 0–1, by shared tokens. */
function likeness(x: string, y: string): number {
  const a = tokens(x).filter((t) => t.trim()),
    b = tokens(y).filter((t) => t.trim());
  if (!a.length || !b.length) return 0;
  return (2 * lcs(a, b, (p, q) => p === q).length) / (a.length + b.length);
}

/**
 * Paragraph rows for the two versions: unchanged paragraphs anchor the alignment; between two
 * anchors, removed and added paragraphs that are still alike pair up as one changed row.
 */
export function diffParagraphs(before: string[], after: string[]): Row[] {
  const anchors = lcs(before, after, (x, y) => x === y);
  const rows: Row[] = [];
  let i = 0,
    j = 0;
  for (const [ai, aj] of [...anchors, [before.length, after.length] as [number, number]]) {
    const gone = before.slice(i, ai),
      come = after.slice(j, aj);
    while (gone.length || come.length) {
      const g = gone[0],
        c = come[0];
      if (g !== undefined && c !== undefined && likeness(g, c) >= 0.35) {
        rows.push({ kind: "changed", ...diffText(g, c) });
        gone.shift();
        come.shift();
      } else if (g !== undefined && (c === undefined || gone.length >= come.length)) {
        rows.push({ kind: "removed", text: g });
        gone.shift();
      } else if (c !== undefined) {
        rows.push({ kind: "added", text: c });
        come.shift();
      }
    }
    if (ai < before.length) rows.push({ kind: "same", text: before[ai] as string });
    i = ai + 1;
    j = aj + 1;
  }
  return rows;
}
