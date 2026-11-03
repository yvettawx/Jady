import { describe, expect, it } from "vitest";
import {
  aiAccess,
  aiLink,
  aiReads,
  isLowering,
  listedOutsideDirectory,
  sessionHasWeb,
  sessionsFor,
  verifiesByDefault,
  webSearch,
} from "./policy";

describe("privacy levels", () => {
  it("gives AI exactly what each level allows", () => {
    expect(aiAccess("normal")).toBe("open");
    expect(aiAccess("sensitive")).toBe("authorized");
    expect(aiAccess("private")).toBe("blocked");
    expect(aiAccess("secret")).toBe("blocked");
  });

  it("guards web search the same way", () => {
    expect(webSearch("normal")).toBe("open");
    expect(webSearch("sensitive")).toBe("confirm");
    expect(webSearch("private")).toBe("blocked");
    expect(webSearch("secret")).toBe("blocked");
  });

  it("confirms only when lowering", () => {
    expect(isLowering("private", "normal")).toBe(true);
    expect(isLowering("secret", "private")).toBe(true);
    expect(isLowering("normal", "secret")).toBe(false);
    expect(isLowering("sensitive", "sensitive")).toBe(false);
  });

  it("keeps secret items out of every list but the directory, and asks before opening", () => {
    expect(listedOutsideDirectory("secret")).toBe(false);
    expect(listedOutsideDirectory("private")).toBe(true);
    expect(verifiesByDefault("secret")).toBe(true);
    expect(verifiesByDefault("private")).toBe(false);
  });

  it("never shows AI the title or id of what it cannot read", () => {
    const of = (level: "normal" | "sensitive" | "private" | "secret") => ({
      id: "x",
      title: "标题",
      level,
    });
    expect(aiLink(of("normal"))).toEqual({ kind: "link", id: "x", title: "标题" });
    expect(aiLink(of("sensitive"))).toEqual({ kind: "protected" });
    expect(aiLink(of("sensitive"), "authorized").kind).toBe("link");
    for (const session of ["plain", "authorized", "webAuthorized"] as const) {
      expect(aiLink(of("private"), session)).toEqual({ kind: "protected" });
      expect(aiLink(of("secret"), session)).toEqual({ kind: "protected" });
    }
    // Missing and hidden look the same.
    expect(aiLink(null)).toEqual(aiLink(of("secret")));
  });

  it("keeps web and 敏感 content apart unless the user marked the item", () => {
    const marked = { level: "sensitive", aiWeb: true } as const;
    const unmarked = { level: "sensitive" } as const;
    // 授权对话 reads all 敏感 content and has no web.
    expect(aiReads(marked, "authorized")).toBe(true);
    expect(aiReads(unmarked, "authorized")).toBe(true);
    expect(sessionHasWeb("authorized")).toBe(false);
    // 联网授权对话 has web and reads only what was marked.
    expect(sessionHasWeb("webAuthorized")).toBe(true);
    expect(aiReads(marked, "webAuthorized")).toBe(true);
    expect(aiReads(unmarked, "webAuthorized")).toBe(false);
    // A plain session never reads 敏感 content, marked or not.
    expect(aiReads(marked, "plain")).toBe(false);
    expect(aiLink({ id: "x", title: "标题", ...unmarked }, "webAuthorized")).toEqual({
      kind: "protected",
    });
  });

  it("does not let the mark open 私密 or 机密 content", () => {
    for (const level of ["private", "secret"] as const)
      for (const session of ["plain", "authorized", "webAuthorized"] as const)
        expect(aiReads({ level, aiWeb: true }, session)).toBe(false);
  });

  it("offers only the sessions the content allows", () => {
    expect(sessionsFor({ level: "normal" })).toEqual(["plain"]);
    expect(sessionsFor({ level: "sensitive" })).toEqual(["authorized"]);
    expect(sessionsFor({ level: "sensitive", aiWeb: true })).toEqual([
      "authorized",
      "webAuthorized",
    ]);
    expect(sessionsFor({ level: "private", aiWeb: true })).toEqual([]);
    expect(sessionsFor({ level: "secret", aiWeb: true })).toEqual([]);
  });
});
