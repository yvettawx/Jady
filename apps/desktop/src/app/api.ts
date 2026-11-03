// The one door to the core (CLAUDE.md: the interface reaches data only through dem-core). The
// generated bindings return { status, data | error }; here a failure simply throws, so calling
// code reads straight through and a toast or an error boundary deals with the rest.
import { listen } from "@tauri-apps/api/event";
import { commands, type CoreError } from "../bindings";

export class CoreFailure extends Error {
  code: string;
  constructor(e: CoreError) {
    super(e.message);
    this.code = e.code;
  }
}

type Typed<T> = { status: "ok"; data: T } | { status: "error"; error: CoreError };

type Unwrapped<C> = {
  [K in keyof C]: C[K] extends (...a: infer A) => Promise<Typed<infer T>>
    ? (...a: A) => Promise<T>
    : C[K];
};

function unwrapped<C extends object>(c: C): Unwrapped<C> {
  return new Proxy(c, {
    get(target, key) {
      const f = target[key as keyof C];
      if (typeof f !== "function") return f;
      return async (...args: unknown[]) => {
        const r = (await (f as (...a: unknown[]) => unknown)(...args)) as unknown;
        if (r && typeof r === "object" && "status" in r) {
          const typed = r as Typed<unknown>;
          if (typed.status === "error") throw new CoreFailure(typed.error);
          return typed.data;
        }
        return r;
      };
    },
  }) as Unwrapped<C>;
}

export const api = unwrapped(commands);

const listeners = new Set<() => void>();

/** Runs `f` whenever an item changes, here or in another window. */
export function onItemsChanged(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Tells this window's lists right away; the core's event then tells the other windows. */
export function itemsChanged() {
  for (const f of listeners) f();
}

let listening = false;
export function listenForChanges() {
  if (listening) return;
  listening = true;
  void listen("items-changed", itemsChanged);
}

export const parseFields = (json: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
