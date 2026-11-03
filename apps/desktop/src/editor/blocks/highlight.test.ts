import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

describe("code highlighting", () => {
  it("marks comments, strings, numbers, keywords and calls, and keeps every character", () => {
    const src = 'const n = 3; // être\nconjugate("aller", n)';
    const t = highlight(src);
    expect(t.map((x) => x.text).join("")).toBe(src);
    const kinds = Object.fromEntries(
      t.filter((x) => x.kind !== "plain").map((x) => [x.text, x.kind]),
    );
    expect(kinds).toMatchObject({
      const: "keyword",
      "3": "number",
      "// être": "comment",
      conjugate: "call",
      '"aller"': "string",
    });
  });
});
