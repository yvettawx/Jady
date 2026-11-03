import { describe, expect, it, vi } from "vitest";
import {
  commands,
  commandsForAi,
  findConflict,
  matchesShortcut,
  registerCommand,
  resetShortcut,
  setShortcut,
  shortcutFromEvent,
  shortcutOf,
} from "./commands";

const key = (init: KeyboardEventInit & { code: string; key: string }) =>
  new KeyboardEvent("keydown", init);

describe("shortcuts", () => {
  it("reads Mod as ⌘ on macOS and Ctrl elsewhere", () => {
    const cmdE = key({ code: "KeyE", key: "E", metaKey: true, shiftKey: true });
    const ctrlE = key({ code: "KeyE", key: "E", ctrlKey: true, shiftKey: true });
    expect(matchesShortcut(cmdE, "Mod+Shift+E", true)).toBe(true);
    expect(matchesShortcut(ctrlE, "Mod+Shift+E", true)).toBe(false);
    expect(matchesShortcut(ctrlE, "Mod+Shift+E", false)).toBe(true);
    expect(matchesShortcut(cmdE, "Mod+Shift+E", false)).toBe(false);
  });

  it("needs exactly the listed modifiers, and finds digits and the backslash by key code", () => {
    expect(matchesShortcut(key({ code: "Digit2", key: "@", metaKey: true }), "Mod+2", true)).toBe(
      true,
    );
    expect(
      matchesShortcut(
        key({ code: "Digit2", key: "2", metaKey: true, shiftKey: true }),
        "Mod+2",
        true,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        key({ code: "Backslash", key: "\\", metaKey: true, altKey: true }),
        "Mod+Alt+\\",
        true,
      ),
    ).toBe(true);
  });

  it("registers and unregisters commands", () => {
    const run = vi.fn();
    const off = registerCommand({ id: "test.x", title: "x", run });
    expect(commands().some((c) => c.id === "test.x")).toBe(true);
    off();
    expect(commands().some((c) => c.id === "test.x")).toBe(false);
  });
});

describe("changing shortcuts", () => {
  it("lets the user's shortcut win, finds conflicts, and goes back to the default", () => {
    const offA = registerCommand({ id: "t.a", title: "A", shortcut: "Mod+Shift+K", run: () => {} });
    const offB = registerCommand({ id: "t.b", title: "B", shortcut: "Mod+J", run: () => {} });
    expect(findConflict("Shift+Mod+k")?.id).toBe("t.a");
    expect(findConflict("Mod+Shift+K", "t.a")).toBeUndefined();
    setShortcut("t.b", "Mod+Alt+J");
    expect(shortcutOf("t.b")).toBe("Mod+Alt+J");
    setShortcut("t.a", null);
    expect(shortcutOf("t.a")).toBeUndefined();
    resetShortcut();
    expect(shortcutOf("t.a")).toBe("Mod+Shift+K");
    offA();
    offB();
  });

  it("records only shortcuts with ⌘/Ctrl or ⌥/Alt", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(shortcutFromEvent(ev({ code: "KeyK", key: "k", metaKey: true }), true)).toBe("Mod+K");
    expect(shortcutFromEvent(ev({ code: "KeyK", key: "k", ctrlKey: true }), false)).toBe("Mod+K");
    expect(
      shortcutFromEvent(ev({ code: "Backslash", key: "«", altKey: true, metaKey: true }), true),
    ).toBe("Mod+Alt+\\");
    expect(shortcutFromEvent(ev({ code: "KeyK", key: "K", shiftKey: true }), true)).toBeNull();
    expect(shortcutFromEvent(ev({ code: "KeyK", key: "k" }), true)).toBeNull();
  });
});

describe("AI and settings", () => {
  it("never offers AI a command that changes settings", () => {
    const off = registerCommand({
      id: "t.dark",
      title: "深色",
      changesSettings: true,
      run: () => {},
    });
    const offOk = registerCommand({ id: "t.open", title: "打开", run: () => {} });
    expect(commands().some((c) => c.id === "t.dark")).toBe(true);
    expect(commandsForAi().some((c) => c.id === "t.dark")).toBe(false);
    expect(commandsForAi().some((c) => c.id === "t.open")).toBe(true);
    off();
    offOk();
  });
});
