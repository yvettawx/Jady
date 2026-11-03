// A small highlighter for code blocks on the P0.5 review pages: comments, strings, numbers,
// keywords and calls. P1 replaces it with CodeMirror's language support (docs/02 §3).

export type TokenKind = "comment" | "string" | "number" | "keyword" | "call" | "plain";

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do break continue switch case default " +
    "new class extends import from export as async await try catch finally throw typeof in of " +
    "true false null undefined def elif lambda pass None True False fn mut pub impl struct enum " +
    "match use mod self where trait"
  ).split(" "),
);

const PATTERN =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

export function highlight(src: string): { kind: TokenKind; text: string }[] {
  const out: { kind: TokenKind; text: string }[] = [];
  let at = 0;
  for (const m of src.matchAll(PATTERN)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ kind: "plain", text: src.slice(at, i) });
    const [text, comment, str, num, call, word] = m;
    const kind: TokenKind = comment
      ? "comment"
      : str
        ? "string"
        : num
          ? "number"
          : call
            ? KEYWORDS.has(call)
              ? "keyword"
              : "call"
            : word && KEYWORDS.has(word)
              ? "keyword"
              : "plain";
    out.push({ kind, text });
    at = i + text.length;
  }
  if (at < src.length) out.push({ kind: "plain", text: src.slice(at) });
  return out;
}
