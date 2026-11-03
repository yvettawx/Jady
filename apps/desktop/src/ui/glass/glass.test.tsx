// Glass (P0.5-06-6). jsdom has no WebGL, so these cover the CSS fallback path and the setting.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { toCss } from "../../theme/color.ts";
import { GLASS, glassBlur, glassPaint } from "../../theme/tokens.ts";
import { Segmented } from "../Segmented";
import { Slider } from "../Slider";
import { useGlass } from "./context";
import { Glass } from "./Glass";
import { GlassBackdrop } from "./GlassBackdrop";
import { GlassProvider } from "./GlassProvider";

function Setter() {
  const { settings, setSettings } = useGlass();
  return (
    <>
      <button onClick={() => setSettings({ ...settings, tinted: true, alpha: 0.6 })}>tint</button>
      <button onClick={() => setSettings({ ...settings, reduce: true })}>reduce</button>
    </>
  );
}

describe("glass setting", () => {
  it("writes the paint and blur for the setting as CSS variables", async () => {
    const user = userEvent.setup();
    render(
      <GlassProvider accent="#12b5a6">
        <Setter />
      </GlassProvider>,
    );
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--dem-glass")).toBe(
      toCss(glassPaint("light", GLASS.alphaDefault)),
    );
    await user.click(screen.getByText("tint"));
    expect(root.getPropertyValue("--dem-glass")).toBe(
      toCss(glassPaint("light", 0.6, true, "#12b5a6")),
    );
    expect(root.getPropertyValue("--dem-glass-blur")).toBe(`${glassBlur(0.6)}px`);
    await user.click(screen.getByText("reduce"));
    expect(document.documentElement.hasAttribute("data-reduce-transparency")).toBe(true);
  });

  it("falls back to CSS blur when WebGL is unavailable", () => {
    const source = document.createElement("canvas");
    render(
      <GlassProvider>
        <GlassBackdrop source={source} />
        <Glass data-testid="panel">目录</Glass>
      </GlassProvider>,
    );
    const panel = screen.getByTestId("panel");
    expect(panel.className).toBe("dem-glass");
    expect(panel.hasAttribute("data-refract")).toBe(false);
  });

  it("tints glass with the space colour, and more opaque glass is more frosted", () => {
    const clear = glassPaint("light", 0.3);
    const tinted = glassPaint("light", 0.3, true, "#ff0000");
    expect(tinted.a).toBeGreaterThan(clear.a);
    expect(tinted.r).toBeGreaterThan(tinted.g);
    expect(glassBlur(GLASS.alphaMax)).toBeGreaterThan(glassBlur(GLASS.alphaMin));
  });
});

describe("controls for the setting", () => {
  it("moves the slider with arrow keys", async () => {
    const user = userEvent.setup();
    let value = 0.3;
    render(
      <Slider
        label="透明度"
        minValue={0.1}
        maxValue={0.85}
        step={0.05}
        defaultValue={0.3}
        onChange={(v) => (value = v)}
      />,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(value).toBeCloseTo(0.4);
  });

  it("picks one segment with the keyboard", async () => {
    const user = userEvent.setup();
    let picked: unknown = "clear";
    render(
      <Segmented
        aria-label="液态玻璃"
        options={[
          { id: "clear", label: "透明" },
          { id: "tinted", label: "着色" },
        ]}
        value="clear"
        onChange={(id) => (picked = id)}
      />,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(picked).toBe("tinted");
  });
});
