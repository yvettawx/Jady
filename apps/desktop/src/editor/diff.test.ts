import { describe, expect, it } from "vitest";
import { diffParagraphs, diffText, tokens } from "./diff";

describe("version diff", () => {
  it("splits 汉字 one by one and keeps Western words whole", () => {
    expect(tokens("复合过去时 passé composé")).toEqual([
      "复",
      "合",
      "过",
      "去",
      "时",
      " ",
      "passé",
      " ",
      "composé",
    ]);
  });

  it("marks a changed word as a word and a changed 汉字 as a character", () => {
    const { before, after } = diffText("j'ai mangé une pomme", "j'ai mangé deux pommes");
    expect(before.filter((p) => p.op === "removed").map((p) => p.text.trim())).toEqual([
      "une pomme",
    ]);
    expect(after.filter((p) => p.op === "added").map((p) => p.text.trim())).toEqual([
      "deux pommes",
    ]);
    const zh = diffText("助动词用 avoir", "助动词多用 avoir");
    expect(zh.after.filter((p) => p.op === "added").map((p) => p.text)).toEqual(["多"]);
  });

  it("folds a stray shared 汉字 inside a rewrite into one change", () => {
    const { before, after } = diffText(
      "少数动词用 être。",
      "表示位置移动和状态变化的十几个动词用 être。",
    );
    expect(before.filter((p) => p.op === "removed")).toHaveLength(1);
    expect(after.filter((p) => p.op === "added")).toHaveLength(1);
    expect(after.at(-1)?.text).toMatch(/用 être。$/);
  });

  it("lines up paragraphs: kept, changed, removed and added", () => {
    const rows = diffParagraphs(
      ["标题", "第一段原文", "要删掉的一段完全不同", "结尾"],
      ["标题", "第一段改过的原文", "结尾", "新加的一段"],
    );
    expect(rows.map((r) => r.kind)).toEqual(["same", "changed", "removed", "same", "added"]);
  });
});
