import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";
import { DEFAULT_ICON_SCHEME, registerIconScheme, resolveIcon, setIconScheme } from "./icons";

const sources = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("icon registry", () => {
  it("is the only place that imports an icon library", () => {
    const offenders = Object.entries(sources)
      .filter(([path, src]) => path !== "/src/ui/icons.ts" && /from\s+["']lucide-react/.test(src))
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });

  it("falls back to the default scheme for icons a scheme leaves out", () => {
    const Dot = () => <svg data-testid="dot" />;
    registerIconScheme({ id: "dots", icons: { close: Dot } });
    setIconScheme("dots");
    try {
      expect(resolveIcon("close")).toBe(Dot);
      expect(resolveIcon("search")).toBeDefined();
      expect(resolveIcon("no-such-icon")).toBeUndefined();
    } finally {
      setIconScheme(DEFAULT_ICON_SCHEME);
    }
  });

  it("renders icons hidden from assistive technology", () => {
    const { container } = render(<Icon name="search" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
