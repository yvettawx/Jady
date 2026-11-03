// The 液态玻璃 setting in Appearance (docs/05-design.md §15, appendix B.2).
import { GLASS } from "../../theme/tokens.ts";

export interface GlassSettings {
  /** 着色: the glass takes on some of the space colour. */
  tinted: boolean;
  /** The slider, GLASS.alphaMin – GLASS.alphaMax. */
  alpha: number;
  /** 减少透明度: glass becomes solid and the refraction layer stops. */
  reduce: boolean;
}

export const DEFAULT_GLASS_SETTINGS: GlassSettings = {
  tinted: false,
  alpha: GLASS.alphaDefault,
  reduce: false,
};
