// The four font slots the user can change in Appearance (docs/05-design.md B.3).
// A chosen font goes in front of the slot's default chain, so text still falls back sensibly on
// a machine that lacks it; rare scripts stay at the end of every chain.
import { FONT } from "./tokens.ts";

export const FONT_SLOTS = ["ui", "long", "display", "mono"] as const;
export type FontSlot = (typeof FONT_SLOTS)[number];

export function fontChain(slot: FontSlot, family: string | null): string {
  const base = `${FONT[slot]}, var(--dem-font-rare)`;
  return family ? `"${family.replace(/["\\]/g, "")}", ${base}` : base;
}

/** Sets or clears (null) the user's font for one slot on the given root element. */
export function applyFont(slot: FontSlot, family: string | null, root: HTMLElement): void {
  if (family) root.style.setProperty(`--dem-font-${slot}`, fontChain(slot, family));
  else root.style.removeProperty(`--dem-font-${slot}`);
}
