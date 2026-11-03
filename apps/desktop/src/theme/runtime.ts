// Theme changes made at run time: the current space's colours and the font size. They override
// the generated theme.css on <html>, using the same derivations as the generator.
import { ensureContrast } from "./color.ts";
import { fillPair, MODES, type Mode } from "./tokens.ts";

const AA = 4.5;

/** CSS variables for a space's three colours in a mode (accent text and fill raised to AA). */
export function spaceVars(mode: Mode, colors: readonly string[]): Record<string, string> {
  const m = MODES[mode];
  const [a = "#5b6cff", b = a, c = a] = colors;
  const { fill, on } = fillPair(a);
  return {
    "--dem-accent": a,
    "--dem-accent2": b,
    "--dem-accent3": c,
    "--dem-accent-text": ensureContrast(a, m.paper, AA, m.text),
    "--dem-accent-fill": fill,
    "--dem-on-accent": on,
  };
}

export function applyVars(root: HTMLElement, vars: Record<string, string>): () => void {
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  return () => {
    for (const k of Object.keys(vars)) root.style.removeProperty(k);
  };
}

/** 字号 in Appearance: a factor on every text size token. */
export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;
