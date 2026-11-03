// The system's 减少透明度 wins over the app setting (P0.5-06 hand test, 2026-10-22).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGlass } from "./context";
import { Glass } from "./Glass";
import { GlassProvider } from "./GlassProvider";

vi.mock("../../theme/system.ts", () => ({ useSystemReduceTransparency: () => true }));

function State() {
  const { settings, systemReduce, reduce } = useGlass();
  return <output>{JSON.stringify({ app: settings.reduce, systemReduce, reduce })}</output>;
}

describe("system reduce transparency", () => {
  it("makes glass solid even when the app setting is off", () => {
    render(
      <GlassProvider>
        <State />
        <Glass>目录</Glass>
      </GlassProvider>,
    );
    expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
      app: false,
      systemReduce: true,
      reduce: true,
    });
    expect(document.documentElement.hasAttribute("data-reduce-transparency")).toBe(true);
    expect(screen.getByText("目录").hasAttribute("data-refract")).toBe(false);
  });
});
