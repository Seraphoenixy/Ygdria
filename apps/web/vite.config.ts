import path from "node:path";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "electron"
      ? [
          electron({
            main: {
              entry: path.resolve(import.meta.dirname, "../desktop/src/main.ts"),
              onstart({ startup }) {
                // Vite runs from apps/web, while Electron's package entry is in apps/desktop.
                // Development terminals (including some Node tooling) can export this
                // compatibility flag. Electron then launches its main entry as plain
                // Node, so `electron.app` is undefined and the desktop process exits.
                delete process.env.ELECTRON_RUN_AS_NODE;
                startup(["../desktop", "--no-sandbox"]);
              },
              vite: {
                build: {
                  outDir: path.resolve(import.meta.dirname, "../desktop/out/main"),
                  lib: false,
                  rolldownOptions: {
                    input: path.resolve(import.meta.dirname, "../desktop/src/main.ts"),
                    // `ws` optionally loads these native accelerators.  If Vite bundles
                    // them, a missing optional package becomes a startup error instead of
                    // falling back to ws's built-in JavaScript implementation.
                    external: ["better-sqlite3", "bufferutil", "utf-8-validate"],
                    output: { entryFileNames: "[name].cjs", format: "cjs" },
                  },
                } as any,
              },
            },
            preload: {
              input: path.resolve(import.meta.dirname, "../desktop/src/preload.ts"),
              // Electron's isolated, sandboxed preload is CommonJS. Use a
              // matching extension as well: a `.mjs` filename can make the
              // packaged runtime treat this CommonJS bundle as ESM, leaving
              // the renderer without its local-API credential bridge.
              vite: {
                build: {
                  outDir: path.resolve(import.meta.dirname, "../desktop/out/preload"),
                  rolldownOptions: { output: { entryFileNames: "[name].cjs", format: "cjs" } },
                },
              },
            },
          }),
        ]
      : [],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/etapi": "http://127.0.0.1:4318",
    },
  },
}));
