import { describe, expect, it } from "vitest";
import { initialsOf, match } from "./match";
import { normalizeSymbols, parseQuery } from "./query";

describe("launcher input", () => {
  it("reads every symbol, half-width, full-width and from a Chinese IME", () => {
    expect(parseQuery("法语").mode).toBe("search");
    expect(parseQuery(">新建记忆卡")).toEqual({
      mode: "command",
      text: "新建记忆卡",
      scope: undefined,
    });
    expect(parseQuery("》切换空间 学习")).toMatchObject({ mode: "command", text: "切换空间 学习" });
    expect(parseQuery("？这周法语学了什么")).toMatchObject({
      mode: "ask",
      text: "这周法语学了什么",
    });
    expect(parseQuery("?/出题 5")).toMatchObject({ mode: "ai-command", text: "出题 5" });
    expect(parseQuery("？、总结")).toMatchObject({ mode: "ai-command", text: "总结" });
    expect(parseQuery("＋记忆卡 le quai 站台")).toMatchObject({
      mode: "new",
      text: "记忆卡 le quai 站台",
    });
    expect(parseQuery("＃求职")).toMatchObject({ mode: "tag", text: "求职" });
    expect(normalizeSymbols("＠＞＋")).toBe("@>+");
  });

  it("takes a scope first and combines it with the rest", () => {
    expect(parseQuery("@法语 ?总结这周的错误")).toEqual({
      mode: "ask",
      text: "总结这周的错误",
      scope: "法语",
    });
    expect(parseQuery("@法")).toEqual({ mode: "scope", text: "法" });
  });
});

describe("launcher matching", () => {
  it("knows pinyin initials, 多音字 included", () => {
    expect(initialsOf("法语 第 12 课")).toBe("fy d 12 k");
    expect(initialsOf("长度")).toBe("cd");
    expect(match("fy", "法语")?.ranges).toEqual([[0, 2]]);
    expect(match("fy", "第 11 课")).toBeNull();
  });

  it("ranks a match at the start over one in the middle, and in one piece over spread out", () => {
    const start = match("法语", "法语课")?.score ?? 0;
    const middle = match("法语", "复习法语")?.score ?? 0;
    const spread = match("fyk", "法语 第 12 课")?.score ?? 0;
    expect(start).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(spread);
    expect(match("fyk", "法语 第 12 课")?.ranges).toEqual([
      [0, 2],
      [8, 9],
    ]);
  });

  it("matches Latin words ignoring case and accents", () => {
    expect(match("passe", "Le passé composé")?.ranges).toEqual([[3, 8]]);
    expect(match("ETRE", "être et avoir")?.ranges).toEqual([[0, 4]]);
  });
});
