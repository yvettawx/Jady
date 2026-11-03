import { describe, expect, it } from "vitest";
import { commands, commandsForAi } from "../shell/commands";
import { registerPrivacyCommand } from "./commands";

describe("changing a privacy level", () => {
  it("is a command for the user and never one for AI", () => {
    const off = registerPrivacyCommand(
      (k) => k,
      () => {},
      () => {},
    );
    expect(commands().some((c) => c.id === "privacy.setLevel")).toBe(true);
    expect(commandsForAi().some((c) => c.id === "privacy.setLevel")).toBe(false);
    off();
  });
});
