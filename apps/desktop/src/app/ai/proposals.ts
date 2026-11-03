// The proposal store on the real queue in the core: same shape the cards and the settings page use,
// but every decision goes to the core and what comes back is the truth.
import {
  allowRules,
  type AllowRule,
  type Proposal,
  type ProposalAction,
  type ProposalStore,
} from "../../ai/proposals";
import type { ProposalView } from "../../bindings";
import { refreshEditors } from "../../editor/pm/ProseEditor";
import type { Translate } from "../../i18n/messages";
import { showToast } from "../../ui/toast";
import { api, CoreFailure, itemsChanged } from "../api";
import { levelOf } from "../model";

const RULES_KEY = "ai-rules";

function toProposal(v: ProposalView, t: Translate, made?: string): Proposal {
  return {
    id: v.id,
    action: v.action as ProposalAction,
    scope: { id: v.scopeId, label: v.scopeLabel || t("ai.scope.all") },
    summary: v.summary,
    target: { id: v.targetId, title: v.targetTitle },
    privacy: levelOf(v.privacy),
    before: v.before,
    after: v.after,
    state: v.state as Proposal["state"],
    byRule: v.byRule,
    madeRule: made,
  };
}

/** Only ever changed by a press in the interface. No AI tool reaches this key (ai_tools tests). */
async function saveRules(rules: readonly AllowRule[]) {
  await api.localSet(
    RULES_KEY,
    JSON.stringify(
      rules.map((r) => ({ id: r.id, action: r.action, scope: r.scope.id, label: r.scope.label })),
    ),
  );
}

export async function loadRules() {
  try {
    const list = JSON.parse((await api.localGet(RULES_KEY)) ?? "[]") as {
      id: string;
      action: ProposalAction;
      scope: string;
      label: string;
    }[];
    allowRules.replace(
      list.map((r) => ({ id: r.id, action: r.action, scope: { id: r.scope, label: r.label } })),
    );
  } catch {
    allowRules.replace([]);
  }
  allowRules.subscribe(() => void saveRules(allowRules.list()));
}

export function createCoreProposalStore(
  t: Translate,
): ProposalStore & { refresh: () => Promise<void> } {
  let items: Proposal[] = [];
  let stale = new Set<string>();
  const made = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((f) => f());
  let asked = 0;
  const refresh = async () => {
    // A newer answer always beats a slower older one.
    const mine = ++asked;
    const list = await api.proposalList();
    if (mine !== asked) return;
    stale = new Set(list.filter((v) => v.stale).map((v) => v.id));
    items = list.map((v) => toProposal(v, t, made.get(v.id)));
    notify();
  };
  const after = (p: Proposal | undefined) => async () => {
    if (p) await refreshEditors(p.target.id);
    itemsChanged();
    await refresh();
  };
  const failed = (e: unknown) => {
    const conflict = e instanceof CoreFailure && (e.code === "conflict" || e.code === "stale");
    showToast({
      text: conflict ? t("ai.proposal.conflict") : e instanceof Error ? e.message : String(e),
      tone: "danger",
    });
    void refresh();
  };
  const find = (id: string) => items.find((p) => p.id === id);
  const store = {
    refresh,
    list: () => items,
    get: find,
    pending: () => items.filter((p) => p.state === "pending"),
    subscribe(f: () => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    add() {
      // Only AI adds, through the gateway; the core has it already.
      void refresh();
    },
    isStale: (id: string) => stale.has(id),
    confirm(id: string, always = false) {
      const p = find(id);
      if (!p || p.state !== "pending") return;
      void api
        .proposalConfirm(id)
        .then(() => {
          if (always) {
            const rule = allowRules.add(p);
            if (rule) made.set(id, rule);
          }
        })
        .then(after(p))
        .catch(failed);
    },
    ignore(id: string) {
      void api.proposalIgnore(id).then(after(undefined)).catch(failed);
    },
    undo(id: string) {
      const p = find(id);
      const rule = made.get(id);
      void api
        .proposalUndo(id)
        .then(() => {
          if (rule) allowRules.remove(rule);
          made.delete(id);
        })
        .then(after(p))
        .catch(failed);
    },
    confirmAll() {
      for (const p of store.pending())
        if (p.action !== "delete" && !stale.has(p.id)) store.confirm(p.id);
    },
  };
  return store as unknown as ProposalStore & { refresh: () => Promise<void> };
}
