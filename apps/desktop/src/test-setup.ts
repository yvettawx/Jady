// Unmount between tests; Testing Library only does this by itself when Vitest globals are on.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// Tests read the reference language, whatever the machine's is.
Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
