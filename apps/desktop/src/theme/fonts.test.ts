import { describe, expect, it } from "vitest";
import { applyFont, fontChain } from "./fonts.ts";
import { FONT } from "./tokens.ts";

describe("font slots", () => {
  it("puts the chosen font in front of the default chain and keeps rare scripts last", () => {
    expect(fontChain("long", "My Serif")).toBe(`"My Serif", ${FONT.long}, var(--dem-font-rare)`);
    expect(fontChain("mono", 'Bad"Name')).toMatch(/^"BadName", /);
  });

  it("sets and clears the slot variable", () => {
    const el = document.createElement("div");
    applyFont("ui", "Inter", el);
    expect(el.style.getPropertyValue("--dem-font-ui")).toBe(fontChain("ui", "Inter"));
    applyFont("ui", null, el);
    expect(el.style.getPropertyValue("--dem-font-ui")).toBe("");
  });
});
