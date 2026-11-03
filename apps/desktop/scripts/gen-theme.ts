// Regenerates src/styles/theme.css from the design tokens. Run with `pnpm run gen:theme`.
import { writeFileSync } from "node:fs";
import { buildCss } from "../src/theme/tokens.ts";

writeFileSync(new URL("../src/styles/theme.css", import.meta.url), buildCss());
console.log("wrote src/styles/theme.css");
