// 提议 (docs/05-design.md §5.4, PRD D9, F4): AI's changes to what already exists wait here until
// you decide. One store, however many places show a proposal, so they cannot disagree.
//
// 以后这类都允许 means one kind of action in one scope (2026-11-02). Rules are made only by the
// user pressing that button and are listed in Settings: nothing here takes a rule from AI.
import { useSyncExternalStore } from "react";
import type { PrivacyLevel } from "../ui/Badge";

export type ProposalAction = "tidy" | "fill-tags" | "add-link" | "merge" | "delete";
export type ProposalState = "pending" | "confirmed" | "ignored";

export interface Proposal {
  id: string;
  action: ProposalAction;
  scope: { id: string; label: string };
  summary: string;
  target: { id: string; title: string };
  privacy: PrivacyLevel;
  before: string[];
  after: string[];
  state: ProposalState;
  /** Took effect through a rule, without asking. */
  byRule?: boolean;
  /** The rule pressing 以后这类都允许 on this one made; undoing it takes the rule back too. */
  madeRule?: string;
}

export interface AllowRule {
  id: string;
  action: ProposalAction;
  scope: { id: string; label: string };
}

/**
 * 删除 always asks (CLAUDE.md). 敏感 content is left out too: it only reaches AI in a session you
 * started, so a standing yes should not outlive that session.
 */
export const canAllowAlways = (p: Pick<Proposal, "action" | "privacy">) =>
  p.action !== "delete" && p.privacy === "normal";

const ruleKey = (action: ProposalAction, scopeId: string) => `${action}@${scopeId}`;

export function createRuleStore() {
  let rules: AllowRule[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((f) => f());
  return {
    list: () => rules,
    subscribe(f: () => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    /** Returns the rule's id, or null if this kind may not have one. */
    add(p: Pick<Proposal, "action" | "privacy" | "scope">): string | null {
      if (!canAllowAlways(p)) return null;
      const id = ruleKey(p.action, p.scope.id);
      if (!rules.some((r) => r.id === id)) {
        rules = [...rules, { id, action: p.action, scope: p.scope }];
        changed();
      }
      return id;
    },
    remove(id: string) {
      rules = rules.filter((r) => r.id !== id);
      changed();
    },
    /** What was kept from before. */
    replace(list: AllowRule[]) {
      rules = list;
      changed();
    },
    covers(p: Pick<Proposal, "action" | "privacy" | "scope">) {
      return canAllowAlways(p) && rules.some((r) => r.id === ruleKey(p.action, p.scope.id));
    },
  };
}
export type RuleStore = ReturnType<typeof createRuleStore>;

/** The rules the user has allowed; Settings lists them. P3 keeps them in the library. */
export const allowRules = createRuleStore();

export function useAllowRules(store: RuleStore = allowRules) {
  return useSyncExternalStore(store.subscribe, store.list);
}

/** Where proposals meet the content. */
export interface ProposalTarget {
  /** Is the text this was written against still there? */
  isCurrent(p: Proposal): boolean;
  apply(p: Proposal): void;
  revert(p: Proposal): void;
}

export function createProposalStore(target: ProposalTarget, rules: RuleStore = allowRules) {
  let items: Proposal[] = [];
  const listeners = new Set<() => void>();
  const set = (id: string, patch: Partial<Proposal>) => {
    items = items.map((p) => (p.id === id ? { ...p, ...patch } : p));
    listeners.forEach((f) => f());
  };
  const find = (id: string) => items.find((p) => p.id === id);
  const store = {
    list: () => items,
    get: find,
    pending: () => items.filter((p) => p.state === "pending"),
    subscribe(f: () => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    /** A new proposal: waits for you, unless a rule you made already says yes. */
    add(p: Omit<Proposal, "state">) {
      const covered = rules.covers(p) && target.isCurrent({ ...p, state: "pending" });
      if (covered) target.apply({ ...p, state: "pending" });
      items = [...items, { ...p, state: covered ? "confirmed" : "pending", byRule: covered }];
      listeners.forEach((f) => f());
    },
    /** Written against text that has since changed: it can only be ignored. */
    isStale(id: string) {
      const p = find(id);
      return !!p && p.state === "pending" && !target.isCurrent(p);
    },
    confirm(id: string, always = false) {
      const p = find(id);
      if (!p || p.state !== "pending" || !target.isCurrent(p)) return;
      target.apply(p);
      const madeRule = always ? (rules.add(p) ?? undefined) : undefined;
      set(id, { state: "confirmed", madeRule });
    },
    ignore(id: string) {
      if (find(id)?.state === "pending") set(id, { state: "ignored" });
    },
    /** Back to waiting; the text goes back, and a rule made by this press goes with it. */
    undo(id: string) {
      const p = find(id);
      if (!p || p.state === "pending") return;
      if (p.state === "confirmed") target.revert(p);
      if (p.madeRule) rules.remove(p.madeRule);
      set(id, { state: "pending", madeRule: undefined, byRule: false });
    },
    /** 批量确认 (PRD D6): only what can go through once. 删除 is decided one at a time. */
    confirmAll() {
      for (const p of store.pending()) if (p.action !== "delete") store.confirm(p.id);
    },
  };
  return store;
}
export type ProposalStore = ReturnType<typeof createProposalStore>;
