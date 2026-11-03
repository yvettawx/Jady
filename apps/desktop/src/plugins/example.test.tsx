// The example in the docs has to keep working: it is what people and AI start from.
import { describe, expect, it } from "vitest";
import { navViews } from "../app/navViews";
import { homeWidgets } from "../home/registry";
import { commands } from "../shell/commands";
import { SCHEMES } from "../theme/tokens.ts";
import { panelDefinition } from "../workspace/registry";
import { startPlugin, type Plugin } from "./api";
import example from "./_example/index";

const host = { t: (k: string) => k, workspace: () => null };

describe("the example plugin", () => {
  it("registers at every extension point, and leaves nothing behind when it stops", () => {
    const stop = startPlugin(example, host);
    expect(panelDefinition("example-panel")).toBeDefined();
    expect(commands().some((c) => c.id === "example.pick")).toBe(true);
    expect(homeWidgets().some((w) => w.id === "example")).toBe(true);
    expect(navViews().some((v) => v.id === "example")).toBe(true);
    expect(Object.keys(SCHEMES)).toContain("example-forest");
    stop();
    expect(panelDefinition("example-panel")).toBeUndefined();
    expect(commands().some((c) => c.id === "example.pick")).toBe(false);
    expect(homeWidgets().some((w) => w.id === "example")).toBe(false);
    expect(navViews().some((v) => v.id === "example")).toBe(false);
    expect(Object.keys(SCHEMES)).not.toContain("example-forest");
  });

  it("runs what the plugin returns when it stops", () => {
    let stopped = false;
    const plugin: Plugin = { id: "t", activate: () => () => (stopped = true) };
    startPlugin(plugin, host)();
    expect(stopped).toBe(true);
  });
});
