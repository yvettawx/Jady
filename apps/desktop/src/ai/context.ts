// The proposal store for whatever is inside: every place a proposal shows reads this one.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Proposal, ProposalStore } from "./proposals";

export const ProposalContext = createContext<ProposalStore | null>(null);

export function useProposals(): { store: ProposalStore; items: Proposal[] } {
  const store = useContext(ProposalContext);
  if (!store) throw new Error("no proposal store");
  return { store, items: useSyncExternalStore(store.subscribe, store.list) };
}
