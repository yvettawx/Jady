// The copy rules a machine can check (docs/05-design.md §14), on every string in the tables. The
// rest of §14 is for people: this catches slips, it does not make writing good.
import { describe, expect, it } from "vitest";
import en from "./en.json";
import zh from "./zh-CN.json";

const HAN = "\\p{Script=Han}";
const offenders = (table: Record<string, string>, pattern: RegExp) =>
  Object.entries(table).flatMap(([k, v]) => (pattern.test(v) ? [`${k}: ${v}`] : []));

describe("copy rules on the string tables", () => {
  it("has no 'XX · XX' labels", () => {
    expect(offenders(zh, / [·•‧] /u)).toEqual([]);
    expect(offenders(en, / [·•‧] /u)).toEqual([]);
  });

  it("has no long dashes", () => {
    expect(offenders(zh, /[—–]/u)).toEqual([]);
    expect(offenders(en, /—/u)).toEqual([]);
  });

  it("has none of the empty big words, and the system does not call itself 我们", () => {
    const words = /赋能|打造|助力|无缝|全方位|极致|闭环|抓手|值得注意的是|总的来说|不难发现|我们/u;
    expect(offenders(zh, words)).toEqual([]);
  });

  it("has no 不是 X 而是 Y or 不仅 X 还 Y", () => {
    expect(offenders(zh, /不是.+而是|不仅.+还/u)).toEqual([]);
  });

  it("puts a space between Chinese and Latin letters or digits", () => {
    const glued = new RegExp(`${HAN}[A-Za-z0-9]|[A-Za-z0-9]${HAN}`, "u");
    expect(offenders(zh, glued)).toEqual([]);
  });

  it("uses full-width punctuation after Chinese", () => {
    expect(offenders(zh, new RegExp(`${HAN}[,.;:!?]`, "u"))).toEqual([]);
  });

  it("does not shout", () => {
    expect(offenders(zh, /[!！]/u)).toEqual([]);
    expect(offenders(en, /!/u)).toEqual([]);
  });

  it("keeps every variable in both languages", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const table = en as Record<string, string>;
    const off = Object.entries(zh).filter(
      ([k, v]) => JSON.stringify(vars(v)) !== JSON.stringify(vars(table[k] ?? "")),
    );
    expect(off).toEqual([]);
  });
});
