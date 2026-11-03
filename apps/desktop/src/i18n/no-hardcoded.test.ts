// Interface text lives in the message files (PRD H7), so a component cannot hold words of its
// own: any Chinese in code, and any text in JSX or in the attributes people read or hear, fails
// here. Comments are fine; development pages and tests are not part of the interface.
import ts from "typescript";
import { describe, expect, it } from "vitest";

const code = import.meta.glob(
  [
    "/src/**/*.{ts,tsx}",
    "!/src/dev/**",
    "!/src/i18n/**",
    "!/src/**/*.test.{ts,tsx}",
    "!/src/**/*.d.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const SPOKEN = new Set(["aria-label", "placeholder", "title", "alt"]);
const HAN = /\p{Script=Han}/u;
const WORD = /\p{L}/u;

function findings(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const note = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${file}:${line + 1} ${what}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (WORD.test(node.text)) note(node, node.text.trim());
    } else if (ts.isJsxAttribute(node)) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value) && SPOKEN.has(node.name.getText())) {
        if (WORD.test(value.text)) note(node, value.text);
      }
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateMiddleOrTemplateTail(node)) {
      if (HAN.test(node.text)) note(node, node.text);
    } else if (ts.isTemplateHead(node)) {
      if (HAN.test(node.text)) note(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("interface text", () => {
  it("is not written into the code", () => {
    expect(Object.keys(code).length).toBeGreaterThan(50);
    const found = Object.entries(code).flatMap(([file, text]) => findings(file, text));
    expect(found).toEqual([]);
  });

  it("finds what it is looking for", () => {
    const sample = `// 注释可以
      const a = "中文"; const b = <p title="Hello">Hi {name}</p>; const c = <i aria-label={t("x")} />;`;
    expect(findings("a.tsx", sample).map((f) => f.split(" ").pop())).toEqual([
      "中文",
      "Hello",
      "Hi",
    ]);
  });
});
