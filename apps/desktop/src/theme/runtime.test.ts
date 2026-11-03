import { describe, expect, it } from "vitest";
import { contrast } from "./color.ts";
import { applyVars, spaceVars } from "./runtime.ts";
import { deriveMode, SCHEMES, type Mode } from "./tokens.ts";

describe.each(["light", "dark"] as Mode[])("space colours at run time, %s", (mode) => {
  it("match what the generator writes for the default space", () => {
    const d = deriveMode(mode);
    expect(spaceVars(mode, SCHEMES.aurora[0])).toEqual({
      "--dem-accent": d.accent,
      "--dem-accent2": d.accent2,
      "--dem-accent3": d.accent3,
      "--dem-accent-text": d.accentText,
      "--dem-accent-fill": d.accentFill,
      "--dem-on-accent": d.onAccent,
    });
  });

  it("keep link text and button text readable for any colour", () => {
    const paper = deriveMode(mode).paper;
    for (const c of ["#ffff00", "#00ffff", "#101010", "#ff6fae"]) {
      const v = spaceVars(mode, [c]);
      expect(contrast(v["--dem-accent-text"] ?? "", paper)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(v["--dem-on-accent"] ?? "", v["--dem-accent-fill"] ?? ""),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it("applyVars sets and then clears the variables", () => {
  const el = document.createElement("div");
  const undo = applyVars(el, { "--dem-font-scale": "1.25" });
  expect(el.style.getPropertyValue("--dem-font-scale")).toBe("1.25");
  undo();
  expect(el.style.getPropertyValue("--dem-font-scale")).toBe("");
});
