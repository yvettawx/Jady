// The recovery code as people read and type it (docs/format-spec.md §4.4): 36 Crockford
// base32 characters in 9 groups of 4. Typing ignores case, spaces and hyphens; I and L read as
// 1, O as 0. The checksum is checked by the core, not here.
export const CODE_LENGTH = 36;
export const GROUP = 4;
const ALPHABET = /[0-9A-HJKMNP-TV-Z]/;

export function normalizeCode(input: string): string {
  return [...input.toUpperCase()]
    .map((c) => (c === "I" || c === "L" ? "1" : c === "O" ? "0" : c))
    .filter((c) => ALPHABET.test(c))
    .join("")
    .slice(0, CODE_LENGTH);
}

export function groupCode(normalized: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < normalized.length; i += GROUP) out.push(normalized.slice(i, i + GROUP));
  return out;
}

export const formatCode = (input: string) => groupCode(normalizeCode(input)).join("-");
