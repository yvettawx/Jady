import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Tauri expects a fixed dev server port and serves the built files from dist/.
// Dev server only: the glass lab (#/glass?perf=…) posts frame times here, including from the
// Tauri window, which has no console we can read. Results land in .perf/ (not committed).
const perfResults: Plugin = {
  name: "dem-perf-results",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__perf", (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        const r = JSON.parse(body) as { name: string };
        mkdirSync(".perf", { recursive: true });
        writeFileSync(`.perf/${r.name}-${Date.now()}.json`, JSON.stringify(r, null, 2));
        res.end("ok");
      });
    });
  },
};

// Dev server only: fonts that a release fetches on demand (fonts.json devOnly), so P0.5 pages
// can show them. They live in .dev-fonts/, outside public/, so a build never ships them.
const devFonts: Plugin = {
  name: "dem-dev-fonts",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/dev-fonts", (req, res, next) => {
      const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0] ?? "");
      const path = `.dev-fonts/${name}`;
      if (!/^[\w.-]+\.ttf$/.test(name) || !existsSync(path)) return next();
      res.setHeader("Content-Type", "font/ttf");
      createReadStream(path).pipe(res);
    });
  },
};

export default defineConfig({
  plugins: [react(), wasm(), perfResults, devFonts],
  clearScreen: false,
  server: {
    // Bind IPv4 explicitly: on Windows "localhost" can resolve to ::1 for Vite while
    // Tauri polls 127.0.0.1, so `tauri dev` waits forever (docs/spikes/04-windows.md).
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: ["es2022", "safari16", "chrome110"],
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    // Keep the generated theme readable in tests so its sync check can compare it.
    // Process CSS (including ?raw imports) so tests can read stylesheets.
    css: { include: [/\.css/] },
  },
});
