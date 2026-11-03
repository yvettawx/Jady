import { beforeEach, describe, expect, it } from "vitest";
import {
  canAllowAlways,
  createProposalStore,
  createRuleStore,
  type Proposal,
  type ProposalStore,
  type RuleStore,
} from "./proposals";

const proposal = (id: string, patch: Partial<Proposal> = {}): Omit<Proposal, "state"> => ({
  id,
  action: "tidy",
  scope: { id: "fr", label: "法语" },
  summary: id,
  target: { id: "note", title: "笔记" },
  privacy: "normal",
  before: ["旧"],
  after: ["新"],
  ...patch,
});

describe("proposals", () => {
  let text: string[];
  let rules: RuleStore;
  let store: ProposalStore;
  beforeEach(() => {
    text = ["旧", "要删的"];
    rules = createRuleStore();
    store = createProposalStore(
      {
        isCurrent: (p) => p.before.every((b) => text.includes(b)),
        apply: (p) => {
          text = text.flatMap((t) => (t === p.before[0] ? p.after : [t]));
        },
        revert: (p) => {
          const at = p.after[0] ? text.indexOf(p.after[0]) : -1;
          if (at >= 0) text[at] = p.before[0] ?? "";
          else text.push(...p.before);
        },
      },
      rules,
    );
  });

  it("changes nothing until confirmed, and can be undone", () => {
    store.add(proposal("a"));
    expect(text[0]).toBe("旧");
    store.confirm("a");
    expect(text[0]).toBe("新");
    expect(store.get("a")?.state).toBe("confirmed");
    store.undo("a");
    expect(text[0]).toBe("旧");
    expect(store.get("a")?.state).toBe("pending");
  });

  it("leaves the text alone when ignored", () => {
    store.add(proposal("a"));
    store.ignore("a");
    expect(text[0]).toBe("旧");
    store.confirm("a");
    expect(text[0]).toBe("旧");
  });

  it("will not apply over text that has changed", () => {
    store.add(proposal("a"));
    store.add(proposal("b", { after: ["别的"] }));
    store.confirm("a");
    expect(store.isStale("b")).toBe(true);
    store.confirm("b");
    expect(text[0]).toBe("新");
    expect(store.get("b")?.state).toBe("pending");
  });

  it("makes a rule only when asked, and it covers that action in that scope only", () => {
    store.add(proposal("a"));
    store.confirm("a");
    expect(rules.list()).toEqual([]);
    store.undo("a");
    store.confirm("a", true);
    expect(rules.list().map((r) => r.id)).toEqual(["tidy@fr"]);
    expect(rules.covers(proposal("x"))).toBe(true);
    expect(rules.covers(proposal("x", { action: "merge" }))).toBe(false);
    expect(rules.covers(proposal("x", { scope: { id: "os", label: "OS" } }))).toBe(false);
  });

  it("applies later ones through the rule, and they can still be undone", () => {
    rules.add(proposal("seed"));
    store.add(proposal("a"));
    expect(text[0]).toBe("新");
    expect(store.get("a")).toMatchObject({ state: "confirmed", byRule: true });
    store.undo("a");
    expect(text[0]).toBe("旧");
    // Undoing one change does not take back a rule made earlier.
    expect(rules.list()).toHaveLength(1);
  });

  it("takes the rule back when the press that made it is undone", () => {
    store.add(proposal("a"));
    store.confirm("a", true);
    store.undo("a");
    expect(rules.list()).toEqual([]);
  });

  it("stops applying once the rule is removed", () => {
    rules.add(proposal("seed"));
    rules.remove("tidy@fr");
    store.add(proposal("a"));
    expect(store.get("a")?.state).toBe("pending");
  });

  it("never lets a deletion through without asking", () => {
    const del = proposal("d", { action: "delete", before: ["要删的"], after: [] });
    expect(canAllowAlways(del)).toBe(false);
    expect(rules.add(del)).toBeNull();
    expect(rules.covers(del)).toBe(false);
    store.add(del);
    expect(store.get("d")?.state).toBe("pending");
    store.confirmAll();
    expect(store.get("d")?.state).toBe("pending");
    expect(text).toContain("要删的");
    store.confirm("d", true);
    expect(text).not.toContain("要删的");
    expect(rules.list()).toEqual([]);
  });

  it("does not let a rule act on 敏感 content", () => {
    const sensitive = proposal("s", { privacy: "sensitive" });
    expect(rules.add(sensitive)).toBeNull();
    rules.add(proposal("seed"));
    store.add(sensitive);
    expect(store.get("s")?.state).toBe("pending");
  });

  it("confirms a batch but skips what is stale", () => {
    store.add(proposal("a"));
    store.add(proposal("b", { after: ["别的"] }));
    store.confirmAll();
    expect(store.get("a")?.state).toBe("confirmed");
    expect(store.get("b")?.state).toBe("pending");
    expect(text[0]).toBe("新");
  });
});
