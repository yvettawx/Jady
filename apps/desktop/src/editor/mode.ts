import { createContext, useContext } from "react";

export type SheetMode = "edit" | "read";

/**
 * The tab's mode for blocks inside the text. The text itself is rendered once and then belongs
 * to the editor, so a mode change must reach the blocks without re-rendering the text.
 */
export const SheetModeContext = createContext<SheetMode>("edit");
export const useSheetMode = () => useContext(SheetModeContext);
