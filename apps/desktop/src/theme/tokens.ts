// Design tokens: the single source for every colour, size, radius, shadow, motion value
// and layer used by the UI (docs/05-design.md §15 and appendix B).
// `src/styles/theme.css` is generated from this file: run `pnpm run gen:theme`.
// A theme pack is a partial override of this data, so nothing here may be hard-coded elsewhere.

import { contrast, ensureContrast, mix, over, parseHex, toCss, type Rgba } from "./color.ts";

export type Mode = "light" | "dark";

/** Three colours per space; the first is the space's accent. */
export const SCHEMES = {
  aurora: [
    ["#5b6cff", "#ff6fae", "#ffb35c"],
    ["#12b5a6", "#3ba4ff", "#b6f06a"],
    ["#ff7a45", "#ffc145", "#e84393"],
  ],
  sunset: [
    ["#ff5e62", "#ffb86b", "#c56cf0"],
    ["#ff9f43", "#ff6b9d", "#ffd166"],
    ["#ee5a24", "#f368e0", "#feca57"],
  ],
  ocean: [
    ["#2e86de", "#00d2d3", "#7c4dff"],
    ["#0abde3", "#10ac84", "#48dbfb"],
    ["#3d5afe", "#54a0ff", "#00d2d3"],
  ],
  forest: [
    ["#10ac84", "#9be3b4", "#f6e58d"],
    ["#6ab04c", "#22a6b3", "#badc58"],
    ["#218c74", "#33d9b2", "#ffda79"],
  ],
  muted: [
    ["#7d8aa8", "#c9b6d9", "#e3c9a8"],
    ["#7fa39a", "#a9c0d6", "#d9d2b4"],
    ["#a8877d", "#d6b8a9", "#c9c3a8"],
  ],
} as const satisfies Record<string, readonly (readonly [string, string, string])[]>;
export type SchemeId = keyof typeof SCHEMES;
/** Three colour sets of three colours each. */
export type SchemeSets = readonly (readonly [string, string, string])[];

/** Plugins add a scheme the same way the built-in ones are listed; its name is `scheme.<id>`. */
export function registerScheme(id: string, sets: SchemeSets): () => void {
  const all = SCHEMES as unknown as Record<string, SchemeSets>;
  all[id] = sets;
  return () => {
    Reflect.deleteProperty(all, id);
  };
}
export const DEFAULT_SCHEME: SchemeId = "aurora";

/** Base colours per mode. Text variants of the coloured ones are derived below. */
export const MODES = {
  light: {
    canvas: "#f6f3f8", // wallpaper base behind the glass
    paper: "#fdfcfa", // the solid sheet that holds long text
    paperLine: "#ebe8e2",
    text: "#1b1b22",
    muted: "#5d5c69",
    faint: "#8c8b97",
    line: "rgba(27, 27, 34, 0.1)",
    hover: "rgba(27, 27, 34, 0.06)",
    ai: "#a855f7",
    ok: "#12a37a",
    warn: "#d9822b",
    danger: "#e5484d",
    onGlass: "#1b1b22", // text on glass
    onGlassMuted: "#3a3945", // secondary text on glass: darker than muted, glass sits on bright colour
    glass: { rgb: "#ffffff", base: 0.18, wallMix: "#ffffff", wallShare: [0.88, 0.72, 0.62] },
  },
  dark: {
    canvas: "#0b0b10",
    paper: "#15151b",
    paperLine: "#26262e",
    text: "#ecebf2",
    muted: "#b0aebd",
    faint: "#74737f",
    line: "rgba(255, 255, 255, 0.085)",
    hover: "rgba(255, 255, 255, 0.07)",
    ai: "#b57bff",
    ok: "#3dd9a4",
    warn: "#ffb35c",
    danger: "#ff6369",
    onGlass: "#f1f0f6",
    onGlassMuted: "#d2d0dd",
    glass: { rgb: "#12121c", base: 0.28, wallMix: "#07070b", wallShare: [0.75, 0.55, 0.45] },
  },
} as const;

/** Privacy levels (PRD F1). 普通 has no colour of its own. */
export const PRIVACY = { sensitive: "#d9822b", private: "#c2417a", secret: "#8a2335" } as const;
/** Source and confidence marks (PRD A8). "mine" uses the muted text colour. */
export const SOURCE = {
  aiMemory: "#a855f7",
  aiSearch: "#12b5a6",
  unverified: "#d9822b",
  conflict: "#e5484d",
} as const;
/** Content types for the heat map and type badges (PRD A1, B1); users can recolour them. */
export const CONTENT = {
  note: "#5b6cff",
  diary: "#ff6fae",
  todo: "#12b5a6",
  card: "#ffb35c",
  question: "#a855f7",
  file: "#7d8aa8",
  entity: "#e84393",
  chat: "#3ba4ff",
} as const;

/** Glass: how the 透明/着色 setting and the slider (0.1–0.85) map to paint. */
export const GLASS = {
  alphaMin: 0.1,
  alphaMax: 0.85,
  alphaDefault: 0.3,
  clearSlope: 0.5, // clear glass paints at base + alpha × 0.5, so it never turns fully see-through
  tintedLift: 0.12, // tinted glass paints at alpha + 0.12
  tintShare: { light: 0.2, dark: 0.18 }, // share of the space colour in tinted glass
};

/** The home star map (docs/05-design.md §8): what is not taken from the space's colours. */
export const STARMAP = {
  light: {
    loose: "#a6a8bb", // 收集箱 items with no cluster
    private: "#8f90a4", // 私密 clusters show as grey
    dust: "#8a8ca8",
    dustOpacity: 0.35,
    nebula: 0.16,
    starGain: 0.85, // colour multiplier for ordinary stars; hubs and open items are brighter
    linkGain: 0.75,
    bloom: { threshold: 0.985, strength: 0.45, radius: 0.55 },
  },
  dark: {
    loose: "#6a6d85",
    private: "#7a7d96",
    dust: "#c8ccff",
    dustOpacity: 0.7,
    nebula: 0.4,
    starGain: 1,
    linkGain: 0.9,
    // Above the wallpaper's brightest glow, so only stars bloom, not the whole background.
    bloom: { threshold: 0.72, strength: 0.75, radius: 0.5 },
  },
  /** Shown while something is hovered: everything not linked to it fades to this share. */
  dim: 0.28,
  /** Degrees per second the whole map turns; 0 with reduced motion. */
  spin: 2,
} as const;

/** Blur radius in px for a slider value: more opaque glass is also more frosted. */
export function glassBlur(alpha: number): number {
  return +(6 + alpha * 16).toFixed(2);
}

/** Opacity actually painted for a slider value. Runtime code must use this too. */
export function glassAlpha(mode: Mode, alpha: number, tinted = false): number {
  return tinted
    ? Math.min(0.95, alpha + GLASS.tintedLift + (mode === "dark" ? 0.1 : 0))
    : MODES[mode].glass.base + alpha * GLASS.clearSlope;
}

export const FONT = {
  ui: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", "Segoe UI", system-ui, sans-serif`,
  long: `"LXGW WenKai", "LXGW WenKai Screen", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", serif`,
  display: `"Archivo", -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif`,
  mono: `"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace`,
  rare: `"Noto Serif Tangut", "Noto Sans Tangut"`,
};

export const SCALE = {
  /** px at font scale 1 */
  text: { xs: 11, sm: 12, base: 13, md: 14, long: 16, lg: 18, xl: 22, "2xl": 28, display: 54 },
  leading: { tight: 1.25, ui: 1.55, long: 1.85 },
  /** Longest line of long text, in em of the long text size (about 38 汉字, 80 Latin letters). */
  measure: { long: 38 },
  space: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 32, 8: 40, 9: 48, 10: 64 },
  radius: { xs: 4, sm: 6, md: 8, lg: 12, xl: 18, "2xl": 22, pill: 999 },
  duration: { instant: 80, fast: 150, base: 240, slow: 360, scene: 560 },
  easing: {
    standard: "cubic-bezier(0.22, 0.8, 0.24, 1)",
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    emphasized: "cubic-bezier(0.2, 0.9, 0.25, 1.05)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
  },
  z: {
    scene: 0,
    panes: 1,
    chrome: 2,
    float: 40,
    peek: 50,
    overlay: 80,
    launcher: 90,
    toast: 95,
    tooltip: 99,
  },
  /** row height and inner padding per density */
  density: { compact: [24, 6], regular: [28, 8], comfortable: [32, 10] },
} as const;

const AA = 4.5,
  AA_LARGE = 3;

/**
 * A solid fill and the text colour that sits on it (primary and danger buttons). White text is
 * kept while it is at least large-text readable, then the fill is darkened until body text reaches
 * AA. Runtime code uses this for space colours the user picks.
 */
export function fillPair(color: string): { fill: string; on: string } {
  const white = "#ffffff",
    ink = "#14141a";
  const cw = contrast(white, color);
  const on = cw >= AA_LARGE || cw >= contrast(ink, color) ? white : ink;
  return { fill: ensureContrast(color, on, AA, on === white ? "#000000" : white), on };
}

/**
 * Three colours for a space whose colour the user picked: the colour itself, a lighter and a
 * deeper companion for the wallpaper's other glows. Text on it is raised to AA by spaceVars.
 */
export function customSpaceColors(hex: string): readonly [string, string, string] {
  return [hex, mix(hex, "#ffffff", 0.55), mix(hex, "#000000", 0.7)];
}

/** All colour tokens for one mode, with text variants raised to AA against paper. */
export function deriveMode(mode: Mode, scheme: SchemeId = DEFAULT_SCHEME) {
  const m = MODES[mode];
  const accent = SCHEMES[scheme][0];
  const asText = (c: string) => ensureContrast(c, m.paper, AA, m.text);
  const asGraphic = (c: string) => ensureContrast(c, m.paper, AA_LARGE, m.text);
  const g = m.glass;
  const glassRgb = parseHex(g.rgb);
  const record = <T extends Record<string, string>>(o: T, f: (c: string) => string) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])) as { [K in keyof T]: string };
  return {
    canvas: m.canvas,
    paper: m.paper,
    paperLine: m.paperLine,
    text: m.text,
    muted: m.muted,
    faint: m.faint,
    line: m.line,
    hover: m.hover,
    onGlass: m.onGlass,
    onGlassMuted: m.onGlassMuted,
    accent: accent[0],
    accent2: accent[1],
    accent3: accent[2],
    accentText: asText(accent[0]),
    accentFill: fillPair(accent[0]).fill,
    onAccent: fillPair(accent[0]).on,
    ai: m.ai,
    aiText: asText(m.ai),
    ok: m.ok,
    okText: asText(m.ok),
    warn: m.warn,
    warnText: asText(m.warn),
    danger: m.danger,
    dangerText: asText(m.danger),
    dangerFill: fillPair(m.danger).fill,
    onDanger: fillPair(m.danger).on,
    privacy: record(PRIVACY, mode === "dark" ? (c) => asText(mix(c, "#ffffff", 0.75)) : asText),
    source: record(SOURCE, mode === "dark" ? (c) => asText(mix(c, "#ffffff", 0.8)) : asText),
    content: record(CONTENT, asGraphic),
    glass: toCss({ ...glassRgb, a: glassAlpha(mode, GLASS.alphaDefault) } as Rgba),
  };
}

/**
 * What a glass panel paints for a setting: colour and opacity. 着色 mixes the space colour into
 * the glass. Runtime code (CSS variable and the WebGL layer) uses this too.
 */
export function glassPaint(mode: Mode, alpha: number, tinted = false, accent?: string): Rgba {
  const g = MODES[mode].glass;
  const rgb = tinted
    ? mix(accent ?? SCHEMES[DEFAULT_SCHEME][0][0], g.rgb, GLASS.tintShare[mode])
    : g.rgb;
  return { ...parseHex(rgb), a: glassAlpha(mode, alpha, tinted) };
}

/** The colours of a space's wallpaper: its three colours pulled toward the mode's base. */
export function wallColors(mode: Mode, space: readonly string[]): string[] {
  const g = MODES[mode].glass;
  return space.map((c, i) => mix(c, g.wallMix, g.wallShare[i] ?? 1));
}

/** The composite colours a reader actually sees through glass, for the contrast test. */
export function glassSamples(mode: Mode, alpha: number, tinted = false) {
  const out: { scheme: SchemeId; wall: string; seen: string }[] = [];
  for (const scheme of Object.keys(SCHEMES) as SchemeId[])
    for (const space of SCHEMES[scheme]) {
      const paint = glassPaint(mode, alpha, tinted, space[0]);
      for (const wall of wallColors(mode, space))
        out.push({ scheme, wall, seen: over(paint, wall) });
    }
  return out;
}

// ---------- CSS ----------

const px = (n: number) => `${n}px`;
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function modeVars(mode: Mode): string[] {
  const d = deriveMode(mode);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string") {
      lines.push(`--dem-${kebab(k)}: ${v};`);
      continue;
    }
    for (const [k2, v2] of Object.entries(v)) lines.push(`--dem-${kebab(k)}-${kebab(k2)}: ${v2};`);
  }
  const sh =
    mode === "light"
      ? [
          "0 1px 2px rgba(30, 20, 70, 0.06)",
          "0 4px 14px rgba(30, 20, 70, 0.1)",
          "0 12px 34px rgba(30, 20, 70, 0.16)",
          "0 24px 60px rgba(30, 20, 70, 0.22)",
        ]
      : [
          "0 1px 2px rgba(0, 0, 0, 0.3)",
          "0 4px 14px rgba(0, 0, 0, 0.35)",
          "0 14px 40px rgba(0, 0, 0, 0.45)",
          "0 24px 60px rgba(0, 0, 0, 0.55)",
        ];
  sh.forEach((v, i) => lines.push(`--dem-shadow-${i + 1}: ${v};`));
  const rim = mode === "light" ? [0.95, 0.2, 0.05, 0.75, 0.42] : [0.42, 0.08, 0.02, 0.3, 0.12];
  lines.push(
    `--dem-glass-rim-1: rgba(255, 255, 255, ${rim[0]});`,
    `--dem-glass-rim-2: rgba(255, 255, 255, ${rim[1]});`,
  );
  lines.push(
    `--dem-glass-rim-3: rgba(255, 255, 255, ${rim[2]});`,
    `--dem-glass-rim-4: rgba(255, 255, 255, ${rim[3]});`,
  );
  lines.push(
    `--dem-glass-spec: rgba(255, 255, 255, ${rim[4]});`,
    `--dem-glass-bright: ${mode === "light" ? 1.1 : 0.92};`,
  );
  lines.push(
    mode === "light"
      ? "--dem-glow: 0 0 10px rgba(255, 255, 255, 0.95), 0 0 26px color-mix(in srgb, var(--dem-accent) 45%, transparent);"
      : "--dem-glow: 0 0 10px color-mix(in srgb, var(--dem-accent) 75%, transparent), 0 0 28px color-mix(in srgb, var(--dem-accent-2) 40%, transparent);",
  );
  lines.push(`color-scheme: ${mode};`);
  return lines;
}

function sharedVars(): string[] {
  const l: string[] = [];
  // Rare scripts (Tangut…) close every chain, so they show whichever slot the text is in.
  for (const [k, v] of Object.entries(FONT))
    l.push(`--dem-font-${k}: ${k === "rare" ? v : `${v}, var(--dem-font-rare)`};`);
  l.push("--dem-font-scale: 1;");
  for (const [k, v] of Object.entries(SCALE.text))
    l.push(`--dem-text-${k}: calc(${px(v)} * var(--dem-font-scale));`);
  for (const [k, v] of Object.entries(SCALE.leading)) l.push(`--dem-leading-${k}: ${v};`);
  for (const [k, v] of Object.entries(SCALE.measure)) l.push(`--dem-measure-${k}: ${v}em;`);
  for (const [k, v] of Object.entries(SCALE.space)) l.push(`--dem-space-${k}: ${px(v)};`);
  for (const [k, v] of Object.entries(SCALE.radius)) l.push(`--dem-radius-${k}: ${px(v)};`);
  for (const [k, v] of Object.entries(SCALE.duration)) l.push(`--dem-dur-${k}: ${v}ms;`);
  for (const [k, v] of Object.entries(SCALE.easing)) l.push(`--dem-ease-${k}: ${v};`);
  for (const [k, v] of Object.entries(SCALE.z)) l.push(`--dem-z-${k}: ${v};`);
  const [rh, pad] = SCALE.density.regular;
  l.push(`--dem-row-h: ${px(rh)};`, `--dem-row-pad: ${px(pad)};`);
  l.push(`--dem-glass-blur: ${px(glassBlur(GLASS.alphaDefault))};`);
  return l;
}

export function buildCss(): string {
  const block = (sel: string, lines: string[]) =>
    `${sel} {\n${lines.map((x) => "  " + x).join("\n")}\n}\n`;
  const dark = modeVars("dark");
  const out = [
    "/*\n * GENERATED by `pnpm run gen:theme` from src/theme/tokens.ts. Do not edit by hand.\n" +
      " * Theme: data-theme on <html> (light | dark; absent = follow the OS).\n" +
      " * Density: data-density (compact | regular | comfortable). Font size: --dem-font-scale.\n */\n",
    block(":root", [...sharedVars(), ...modeVars("light")]),
    block(':root[data-theme="dark"]', dark),
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', dark).replace(/^/gm, "  ").trimEnd()}\n}\n`,
    ...(["compact", "comfortable"] as const).map((d) =>
      block(`:root[data-density="${d}"]`, [
        `--dem-row-h: ${px(SCALE.density[d][0])};`,
        `--dem-row-pad: ${px(SCALE.density[d][1])};`,
      ]),
    ),
    block("html,\nbody", [
      "margin: 0;",
      "background: var(--dem-canvas);",
      "color: var(--dem-text);",
      "font-family: var(--dem-font-ui);",
      "font-size: var(--dem-text-base);",
      "line-height: var(--dem-leading-ui);",
    ]),
    `@media (prefers-reduced-motion: reduce) {\n  :root {\n${Object.keys(SCALE.duration)
      .map((k) => `    --dem-dur-${k}: 0ms;`)
      .join("\n")}\n  }\n}\n`,
  ];
  return out.join("\n");
}
