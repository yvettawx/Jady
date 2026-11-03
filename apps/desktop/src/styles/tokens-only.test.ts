// Interface code may not hard-code colours or durations: a theme pack is a partial override of
// the tokens, so anything written down elsewhere would escape it (docs/05-design.md appendix B).
// The token source (src/theme/), the generated theme.css and the development pages are exempt.
import { describe, expect, it } from "vitest";

const css = import.meta.glob(["/src/**/*.css", "!/src/styles/theme.css", "!/src/dev/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const code = import.meta.glob(
  ["/src/**/*.{ts,tsx}", "!/src/theme/**", "!/src/dev/**", "!/src/**/*.test.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const COLOR =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(|(?<![\w-])(?:white|black|red|blue|green|gray|grey)(?![\w-])/g;
const DURATION = /(?<![\w-])\d*\.?\d+m?s\b/g;
/** Mask images only use the shape of a colour, never show it. */
const allowed = (line: string) => /linear-gradient\(#000 0 0\)/.test(line);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

function offenders(files: Record<string, string>, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [path, src] of Object.entries(files))
    stripComments(src)
      .split("\n")
      .forEach((line, i) => {
        if (!allowed(line) && line.match(pattern)) out.push(`${path}:${i + 1}: ${line.trim()}`);
      });
  return out;
}

describe("tokens only", () => {
  it("finds the component stylesheets", () => {
    expect(Object.keys(css).length).toBeGreaterThan(10);
    expect(Object.values(css).every((src) => src.length > 0)).toBe(true);
  });

  it("has no hard-coded colours in component styles", () => {
    expect(offenders(css, COLOR)).toEqual([]);
  });

  it("has no hard-coded durations in component styles", () => {
    expect(offenders(css, DURATION)).toEqual([]);
  });

  it("has no colour literals in component code", () => {
    const literal = /["'`](?:#[0-9a-fA-F]{3,8}|rgba?\()/;
    expect(offenders(code, literal)).toEqual([]);
  });
});
