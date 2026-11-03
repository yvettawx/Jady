import { createContext, useContext } from "react";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "./settings";

export interface GlassContextValue {
  settings: GlassSettings;
  setSettings: (s: GlassSettings) => void;
  /** The system asks for reduced transparency; glass is solid whatever settings.reduce says. */
  systemReduce: boolean;
  /** In effect: the app setting or the system setting. */
  reduce: boolean;
  /** Whether the WebGL layer is drawing refraction right now. */
  refracting: boolean;
  setRefracting: (on: boolean) => void;
  /** Glass panels register so the pointer light and the WebGL layer can find them. */
  register: (el: HTMLElement) => () => void;
  elements: () => Iterable<HTMLElement>;
}

export const GlassContext = createContext<GlassContextValue>({
  settings: DEFAULT_GLASS_SETTINGS,
  setSettings: () => {},
  systemReduce: false,
  reduce: false,
  refracting: false,
  setRefracting: () => {},
  register: () => () => {},
  elements: () => [],
});

export const useGlass = () => useContext(GlassContext);
