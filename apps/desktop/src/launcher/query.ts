// What the launcher's input means (docs/05-design.md §4.2): the leading symbol picks the mode,
// `@范围` narrows the scope and combines with the others. Full-width and Chinese-IME forms of
// the symbols count too (＞》？＋＃＠／), so nobody has to switch input methods.

export type LauncherMode = "search" | "command" | "ask" | "ai-command" | "new" | "tag" | "scope";

export interface LauncherQuery {
  mode: LauncherMode;
  /** The text after the symbol (and after the scope), trimmed at the start. */
  text: string;
  /** `@法语` given before the rest, finished with a space. */
  scope?: string;
}

/** Full-width ASCII to half-width (NFKC), plus the IME's 》 for >. */
export function normalizeSymbols(s: string): string {
  return s.normalize("NFKC").replace(/》/g, ">").replace(/、/g, "/");
}

export function parseQuery(raw: string): LauncherQuery {
  let s = normalizeSymbols(raw).replace(/^\s+/, "");
  let scope: string | undefined;
  const at = /^@(\S+)\s+/.exec(s);
  if (at) {
    scope = at[1];
    s = s.slice(at[0].length);
  } else if (s.startsWith("@")) {
    // Still typing the scope: list scopes.
    return { mode: "scope", text: s.slice(1) };
  }
  const rest = (n: number) => s.slice(n).replace(/^\s+/, "");
  if (s.startsWith("?/")) return { mode: "ai-command", text: rest(2), scope };
  if (s.startsWith("?")) return { mode: "ask", text: rest(1), scope };
  if (s.startsWith(">")) return { mode: "command", text: rest(1), scope };
  if (s.startsWith("+")) return { mode: "new", text: rest(1), scope };
  if (s.startsWith("#")) return { mode: "tag", text: rest(1), scope };
  return { mode: "search", text: s, scope };
}
