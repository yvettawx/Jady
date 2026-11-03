// Matching for the launcher (docs/05-design.md §4.2, docs/03-modules.md M11): a word as typed,
// pinyin initials for Chinese (法语 ← fy, 长度 ← cd: pinyin-pro knows 多音字), and loose
// in-order letters. Accents do not matter (passe finds passé). Each match says which
// characters to highlight.
import { pinyin } from "pinyin-pro";

export interface Match {
  score: number;
  /** [start, end) ranges in the candidate, for highlighting. */
  ranges: [number, number][];
}

const HAN = /\p{Script=Han}/u;
/** é → e, lower-cased; always one character in, one out. */
const fold = (c: string) => c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase() || c;
const keyCache = new Map<string, string>();

/**
 * One key per character of the text: a 汉字's pinyin initial, otherwise the character itself
 * lower-cased. Same length as the text, so positions carry over to the highlight.
 */
export function initialsOf(text: string): string {
  const hit = keyCache.get(text);
  if (hit !== undefined) return hit;
  const chars = [...text];
  const firsts = chars.some((c) => HAN.test(c))
    ? (pinyin(text, { pattern: "first", toneType: "none", type: "array" }) as string[])
    : [];
  // pinyin-pro returns one entry per character (non-Han characters come back as they are).
  const key = chars.map((c, i) => (HAN.test(c) ? (firsts[i]?.[0] ?? c) : c).toLowerCase()).join("");
  if (keyCache.size > 5000) keyCache.clear();
  keyCache.set(text, key);
  return key;
}

/** Positions (in characters) where a new word starts: after a space or mark, or each 汉字. */
function wordStarts(chars: string[]): Set<number> {
  const out = new Set<number>([0]);
  chars.forEach((c, i) => {
    const prev = chars[i - 1];
    if (HAN.test(c) || (prev !== undefined && /[\s\-_/·:：、（(]/.test(prev))) out.add(i);
  });
  return out;
}

function toRanges(positions: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of positions) {
    const last = out.at(-1);
    if (last && last[1] === p) last[1] = p + 1;
    else out.push([p, p + 1]);
  }
  return out;
}

/** How well `query` matches `text`; null when it does not. Higher is better. */
export function match(query: string, text: string): Match | null {
  const q = [...query.trim()].filter((c) => !/\s/.test(c)).map(fold);
  if (!q.length) return { score: 0, ranges: [] };
  const chars = [...text];
  const plain = chars.map(fold);
  const keys = [...initialsOf(text)];
  const starts = wordStarts(chars);
  const qs = q.join("");

  // 1. The query as typed, in one piece.
  const at = plain.join("").indexOf(qs);
  if (at >= 0) {
    const pos = [...plain.join("").slice(0, at)].length;
    return {
      score: 1000 - pos + (pos === 0 ? 200 : starts.has(pos) ? 100 : 0) - chars.length,
      ranges: [[pos, pos + q.length]],
    };
  }
  // 2. Pinyin initials in one piece: fy → 法语.
  const ki = keys.join("").indexOf(qs);
  if (ki >= 0 && q.every((c) => /[a-z]/.test(c))) {
    return {
      score: 800 - ki + (ki === 0 ? 150 : 0) - chars.length,
      ranges: [[ki, ki + q.length]],
    };
  }
  // 3. In order but spread out, preferring word starts; against the text or its initials.
  const positions: number[] = [];
  let j = 0;
  for (let i = 0; i < chars.length && j < q.length; i++) {
    if (plain[i] === q[j] || keys[i] === q[j]) {
      positions.push(i);
      j++;
    }
  }
  if (j < q.length) return null;
  const atStarts = positions.filter((p) => starts.has(p)).length;
  const spread = (positions.at(-1) ?? 0) - (positions[0] ?? 0) - positions.length;
  return { score: 400 + atStarts * 30 - spread * 5 - chars.length, ranges: toRanges(positions) };
}
