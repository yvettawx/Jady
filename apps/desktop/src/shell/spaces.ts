// Spaces (docs/05-design.md §2.5): each has a name, a colour, its own layout and home. Only the
// default 主空间 exists until the user adds more. The 配色方案 is one setting for the whole
// app (Appearance); a space takes one of its colour sets, or a colour the user picked.
import { customSpaceColors, SCHEMES, type SchemeId } from "../theme/tokens.ts";

export interface Space {
  id: string;
  name: string;
  /** Which of the scheme's colour sets (0–2), or a colour the user picked ("#rrggbb"). */
  color: number | string;
}

export function spaceColors(s: Space, scheme: SchemeId): readonly [string, string, string] {
  if (typeof s.color === "string") return customSpaceColors(s.color);
  return SCHEMES[scheme][s.color] ?? SCHEMES[scheme][0] ?? SCHEMES.aurora[0];
}
