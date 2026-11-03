import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFocusRescue } from "./focus";

describe("focus rescue", () => {
  let off: () => void;
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => setTimeout(() => f(0), 0));
    document.body.innerHTML = `
      <div id="page" data-focus-home="page" tabindex="-1">
        <article id="card" data-focus-home="card" tabindex="-1"><button id="b">确认</button></article>
        <button id="other">别的</button>
      </div>`;
    off = installFocusRescue();
  });
  afterEach(() => {
    off();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("goes to the nearest home when the focused button goes away", async () => {
    byId("b").focus();
    byId("b").remove();
    await tick();
    expect(document.activeElement).toBe(byId("card"));
  });

  it("goes to the page when the card went too", async () => {
    byId("b").focus();
    byId("card").remove();
    await tick();
    expect(document.activeElement).toBe(byId("page"));
  });

  it("leaves focus alone when something else already took it", async () => {
    byId("b").focus();
    byId("b").remove();
    byId("other").focus();
    await tick();
    expect(document.activeElement).toBe(byId("other"));
  });

  it("does nothing while what has focus stays", async () => {
    byId("b").focus();
    byId("other").remove();
    await tick();
    expect(document.activeElement).toBe(byId("b"));
  });
});
