// Small colour helpers for the design tokens: parsing, mixing, alpha compositing and
// WCAG 2.x contrast. Pure functions, no DOM, so the generator and the tests can share them.

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { a: number };

export function parseHex(hex: string): Rgba {
  let h = /^#([0-9a-f]{3,8})$/i.exec(hex.trim())?.[1] ?? "";
  if (![3, 4, 6, 8].includes(h.length)) throw new Error(`not a hex colour: ${hex}`);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function toCss(c: Rgba): string {
  if (c.a >= 1) return toHex(c);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`;
}

/** Mixes in sRGB: `p` = share of `a` (1 → a, 0 → b). */
export function mix(a: string, b: string, p: number): string {
  const x = parseHex(a),
    y = parseHex(b);
  return toHex({
    r: x.r * p + y.r * (1 - p),
    g: x.g * p + y.g * (1 - p),
    b: x.b * p + y.b * (1 - p),
  });
}

/** Paints a translucent colour over an opaque one. */
export function over(top: Rgba, under: string): string {
  const u = parseHex(under);
  return toHex({
    r: top.r * top.a + u.r * (1 - top.a),
    g: top.g * top.a + u.g * (1 - top.a),
    b: top.b * top.a + u.b * (1 - top.a),
  });
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Moves `fg` towards `toward` (usually the text colour) in small steps until it reaches
 * `min` contrast on `bg`. Used for any user-picked colour that becomes text, such as
 * links in a custom space colour.
 */
export function ensureContrast(fg: string, bg: string, min: number, toward: string): string {
  let c = fg;
  for (let p = 1; p >= 0 && contrast(c, bg) < min; p -= 0.05) c = mix(fg, toward, p);
  return c;
}
