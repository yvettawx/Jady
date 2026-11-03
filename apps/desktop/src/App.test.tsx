import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./bindings", () => ({
  commands: {
    libraryIsOpen: () => Promise.resolve(false),
    libraryStart: () =>
      Promise.resolve({
        mode: "first-run",
        library: null,
        details: null,
        defaultLocation: "/tmp/libraries",
      }),
    systemAppearance: () => Promise.resolve({ reduceTransparency: false }),
    diag: () => Promise.resolve(),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

describe("App", () => {
  it("starts at the welcome step when there is no library yet", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: "新建资料库" })).toBeTruthy();
  });
});
