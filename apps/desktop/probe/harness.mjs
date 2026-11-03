// Shared by the end-to-end probes: the real interface on the real core (src-tauri/src/e2e.rs), with a
// library already made so each probe starts where its subject starts.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const ROOT = resolve(import.meta.dirname, "../../..");
export const PASSWORD = "Correct-horse-9";

// Tauri injects its globals into the main frame only; so does this, or plugin frames would get them.
export const shim = (bridge) => `if (window.top === window) {
  window.__dialogs = [];
  window.__JADY_PLUGIN_BASE__ = "${bridge}/__plugin/";
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  let cb = 1;
  const callbacks = new Map();
  window.__events = {};
  window.__emit = (event, payload) => {
    for (const id of window.__events[event] ?? []) callbacks.get(id)?.({ event, payload, id: 0 });
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: (f) => { const id = cb++; callbacks.set(id, f); return id; },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd === "plugin:event|listen") {
        (window.__events[args.event] ??= []).push(args.handler);
        return args.handler;
      }
      if (cmd === "plugin:dialog|open" || cmd === "plugin:dialog|save") return window.__dialogs.shift() ?? null;
      if (cmd === "plugin:notification|is_permission_granted") return false;
      if (cmd.startsWith("plugin:")) return null;
      const r = await fetch("${bridge}/" + cmd, { method: "POST", body: JSON.stringify(args ?? {}) });
      const body = await r.json();
      if (!r.ok) throw body;
      return body;
    },
  };
  window.print = () => { window.__printed = true; };
  (function poll() {
    fetch("${bridge}/__events", { method: "POST", body: "{}" }).then((r) => r.json()).then((list) => {
      for (const [event, payload] of list) window.__emit(event, payload);
    }).catch(() => {}).finally(() => setTimeout(poll, 150));
  })();
}`;

export function buildBridge() {
    const built = spawnSync(
        "cargo",
        ["build", "-q", "-p", "dem-desktop", "--features", "e2e", "--example", "e2e_bridge"],
        { cwd: ROOT, stdio: "inherit" },
    );
    if (built.status !== 0) process.exit(1);
}

/** Runs `body({ page, call, check, wait, shot, dir })` per engine; returns how many checks failed. */
export async function withApp(tag, body, { engines = [webkit], port = 1461, env = {} } = {}) {
    buildBridge();
    const server = await createServer({
        server: { port: 0, host: "127.0.0.1" },
        logLevel: "error",
    });
    await server.listen();
    const base = server.resolvedUrls.local[0];
    let failed = 0;
    for (const engine of engines) {
        const name = engine.name();
        const check = (label, ok, detail) => {
            if (!ok) failed++;
            console.log(
                `${name.padEnd(9)} ${ok ? "PASS" : "FAIL"} ${tag}：${label}${ok ? "" : "  " + JSON.stringify(detail ?? null)}`,
            );
        };
        const dir = mkdtempSync(join(tmpdir(), "dem-e2e-"));
        const bridgeUrl = `http://127.0.0.1:${port}`;
        const bridge = spawn(join(ROOT, "target/debug/examples/e2e_bridge"), [String(port), dir], {
            stdio: ["ignore", "pipe", "inherit"],
            env: { ...process.env, ...env },
        });
        await new Promise((ok) => bridge.stdout.once("data", ok));
        const call = async (cmd, args = {}) => {
            const r = await fetch(`${bridgeUrl}/${cmd}`, {
                method: "POST",
                body: JSON.stringify(args),
            });
            const b = await r.json();
            if (!r.ok) throw new Error(cmd + JSON.stringify(b));
            return b;
        };
        await call("library_prepare", { name: "t", dir: `${dir}/documents`, password: PASSWORD });
        await call("library_commit");
        // The first-time guide has its own check in app.mjs.
        if (!process.env.PROBE_FRESH) await call("local_set", { key: "ui-welcomed", value: "1" });
        const browser = await engine.launch(
            engine === chromium ? { args: ["--use-angle=metal"] } : {},
        );
        const context = await browser.newContext({
            locale: process.env.PROBE_LOCALE ?? "zh-CN",
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
        });
        await context.addInitScript(shim(bridgeUrl));
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        const wait = (ms) => page.waitForTimeout(ms);
        const shot = async (n) => {
            if (process.env.SHOTS)
                await page.screenshot({ path: join(process.env.SHOTS, `${tag}-${n}.png`) });
        };
        try {
            await page.goto(base);
            await page.waitForSelector(".dem-shell", { timeout: 20000 });
            await wait(800);
            await body({ page, call, check, wait, shot, dir, context, base });
        } catch (e) {
            check("流程走完", false, String(e).slice(0, 900));
            await shot("99-failed");
        }
        const real = errors.filter(
            (e) =>
                !/Failed to load resource|ResizeObserver|texImage3D|Cannot find the loroNode|WebSocket|access control checks|Load failed|Notification prompting|Content Security Policy|Refused to|sandboxed frame/.test(
                    e,
                ),
        );
        check("页面没有报错", real.length === 0, real.slice(0, 5));
        await context.close();
        await browser.close();
        bridge.kill();
        rmSync(dir, { recursive: true, force: true });
    }
    await server.close();
    return failed;
}
