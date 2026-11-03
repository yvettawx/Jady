import { describe, expect, it } from "vitest";
import css from "../styles/theme.css?raw";
import { contrast, ensureContrast, mix } from "./color.ts";
import {
  GLASS,
  MODES,
  SCHEMES,
  buildCss,
  deriveMode,
  fillPair,
  glassSamples,
  type Mode,
} from "./tokens.ts";

// WCAG 2.x: 4.5 for body text, 3 for large text and meaningful graphics.
const AA = 4.5;
const AA_LARGE = 3;
const modes: Mode[] = ["light", "dark"];

describe("theme.css", () => {
  it("is generated from tokens.ts (run `pnpm run gen:theme`)", () => {
    expect(css).toBe(buildCss());
  });
});

describe.each(modes)("contrast in %s mode", (mode) => {
  const d = deriveMode(mode);
  const m = MODES[mode];

  it("body text, secondary text and hints on paper", () => {
    expect(contrast(d.text, d.paper)).toBeGreaterThanOrEqual(AA);
    expect(contrast(d.muted, d.paper)).toBeGreaterThanOrEqual(AA);
    expect(contrast(d.faint, d.paper)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("coloured text on paper", () => {
    const texts = {
      ...d.privacy,
      ...d.source,
      ai: d.aiText,
      ok: d.okText,
      warn: d.warnText,
      danger: d.dangerText,
    };
    for (const [name, c] of Object.entries(texts))
      expect([name, contrast(c, d.paper)]).toEqual([name, expect.any(Number)]);
    for (const c of Object.values(texts)) expect(contrast(c, d.paper)).toBeGreaterThanOrEqual(AA);
  });

  it("every space accent becomes readable link text", () => {
    for (const scheme of Object.values(SCHEMES))
      for (const [accent] of scheme)
        expect(
          contrast(ensureContrast(accent, m.paper, AA, m.text), m.paper),
        ).toBeGreaterThanOrEqual(AA);
  });

  it("text on filled buttons, for every space accent and for danger", () => {
    for (const scheme of Object.values(SCHEMES))
      for (const [accent] of scheme) {
        const { fill, on } = fillPair(accent);
        expect(contrast(on, fill)).toBeGreaterThanOrEqual(AA);
      }
    expect(contrast(d.onAccent, d.accentFill)).toBeGreaterThanOrEqual(AA);
    expect(contrast(d.onDanger, d.dangerFill)).toBeGreaterThanOrEqual(AA);
  });

  it("content-type colours stand out from paper", () => {
    for (const c of Object.values(d.content))
      expect(contrast(c, d.paper)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("text on glass at the default setting, over every wallpaper colour", () => {
    for (const s of glassSamples(mode, GLASS.alphaDefault)) {
      expect(contrast(d.onGlass, s.seen)).toBeGreaterThanOrEqual(AA);
      expect(contrast(d.onGlassMuted, s.seen)).toBeGreaterThanOrEqual(AA);
    }
  });

  it("text on tinted glass, at the default and the most transparent setting", () => {
    for (const s of glassSamples(mode, GLASS.alphaDefault, true)) {
      expect(contrast(d.onGlass, s.seen)).toBeGreaterThanOrEqual(AA);
      expect(contrast(d.onGlassMuted, s.seen)).toBeGreaterThanOrEqual(AA);
    }
    for (const s of glassSamples(mode, GLASS.alphaMin, true)) {
      expect(contrast(d.onGlass, s.seen)).toBeGreaterThanOrEqual(AA);
      expect(contrast(d.onGlassMuted, s.seen)).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("text on glass at the most transparent setting stays legible", () => {
    for (const s of glassSamples(mode, GLASS.alphaMin)) {
      expect(contrast(d.onGlass, s.seen)).toBeGreaterThanOrEqual(AA);
      expect(contrast(d.onGlassMuted, s.seen)).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });
});

describe("ensureContrast", () => {
  it("raises any colour a user might pick to the target", () => {
    for (let i = 0; i < 200; i++) {
      const c =
        "#" +
        Math.floor(Math.random() * 0xffffff)
          .toString(16)
          .padStart(6, "0");
      for (const mode of modes) {
        const m = MODES[mode];
        expect(contrast(ensureContrast(c, m.paper, AA, m.text), m.paper)).toBeGreaterThanOrEqual(
          AA,
        );
      }
    }
  });

  it("leaves a colour alone when it already passes", () => {
    expect(ensureContrast("#1b1b22", "#ffffff", AA, "#000000")).toBe("#1b1b22");
    expect(mix("#000000", "#ffffff", 1)).toBe("#000000");
  });
});
