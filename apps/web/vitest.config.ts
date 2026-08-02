import { defineConfig } from "vitest/config";

// Vitest uses Vite's resolver, which applies the `browser` field in
// secure-remote-password's package.json and substitutes a slow pure-JS sha256
// for the Node crypto-backed one. Tests don't need the browser variant, so
// alias it back to the fast Node implementation. (The production browser build
// is unaffected — it still resolves the browser field via vite.config.ts.)
export default defineConfig({
  resolve: {
    alias: {
      "secure-remote-password/browser/sha256.js": "secure-remote-password/lib/sha256.js",
    },
  },
});
