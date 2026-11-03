// What the side panels and the status bar need to know about the notes that are open. Each note
// panel publishes here, and the workspace says which one is in front.
import { useSyncExternalStore } from "react";
import type { PrivacyLevel } from "../ui/Badge";

export interface Heading {
  level: number;
  text: string;
  pos: number;
}

export interface OpenNote {
  id: string;
  title: string;
  privacy: PrivacyLevel;
  aiWeb: boolean;
  words: number;
  saving: boolean;
  headings: Heading[];
  goTo?: (pos: number) => void;
  flush?: () => Promise<void>;
  /** Puts text at the caret: the character panel. */
  insert?: (text: string) => void;
}

const notes = new Map<string, OpenNote>();
let active: string | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};

export function publishNote(id: string, info: Partial<OpenNote>): void {
  const old = notes.get(id);
  notes.set(id, {
    id,
    title: "",
    privacy: "normal",
    aiWeb: false,
    words: 0,
    saving: false,
    headings: [],
    ...old,
    ...info,
  });
  changed();
}

export function closeNote(id: string): void {
  notes.delete(id);
  changed();
}

export function setActiveNote(id: string | null): void {
  if (active === id) return;
  active = id;
  changed();
}

export const activeNoteId = () => active;

/** Sends whatever the open editors have not saved yet. */
export const flushNotes = () =>
  Promise.all([...notes.values()].map((n) => n.flush?.())).then(() => undefined);

export function useActiveNote(): OpenNote | null {
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => version,
  );
  return (active && notes.get(active)) || null;
}

export type { PrivacyLevel };
