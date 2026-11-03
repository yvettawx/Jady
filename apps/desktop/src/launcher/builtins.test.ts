import { describe, expect, it } from "vitest";
import {
  aiCommandSource,
  askSource,
  contentSource,
  tagSource,
  type ContentEntry,
} from "./builtins";
import { parseQuery } from "./query";
import type { LauncherContext } from "./sources";

const t = (k: string) => k;
const ctx = (privacy: LauncherContext["privacy"]): LauncherContext => ({
  privacy,
  setInput: () => {},
  close: () => {},
});
const entries: ContentEntry[] = [
  {
    id: "a",
    title: "保单",
    path: "生活",
    icon: "file",
    tags: ["证件"],
    privacy: "secret",
    recent: 2,
  },
  {
    id: "b",
    title: "保养记录",
    path: "生活",
    icon: "file",
    tags: ["证件"],
    privacy: "private",
    recent: 1,
  },
];

describe("privacy in the launcher", () => {
  it("never lists secret items, in search, recents or tag counts", () => {
    const content = contentSource(
      t,
      () => entries,
      () => {},
    );
    const ids = (q: string) => content.search(parseQuery(q), ctx("normal")).map((x) => x.id);
    expect(ids("保")).toEqual(["content:b"]);
    expect(ids("")).toEqual(["content:b"]);
    expect(ids("#证件")).toEqual(["content:b"]);
    const tags = tagSource(t as never, () => entries).search(parseQuery("#证"), ctx("normal"));
    expect(tags[0]?.meta).toBe("launcher.count");
    expect(JSON.stringify(tags)).not.toContain("保单");
  });

  it("greys AI in private and secret content, not in normal or sensitive", () => {
    const ask = askSource(t, () => {});
    const q = parseQuery("?这周");
    for (const level of ["private", "secret"] as const)
      expect(ask.search(q, ctx(level))[0]?.disabledReason).toBe(`privacy.aiBlocked.${level}`);
    for (const level of ["normal", "sensitive"] as const)
      expect(ask.search(q, ctx(level))[0]?.disabledReason).toBeUndefined();
    const cmd = aiCommandSource(t, () => {});
    expect(cmd.search(parseQuery("?/"), ctx("secret"))[0]?.disabledReason).toBeDefined();
  });
});
