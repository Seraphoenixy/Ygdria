import { defineConfig } from "vitest/config";

// Vitest uses Vite's resolver, which applies the `browser` field in
// secure-remote-password's package.json and substitutes a slow pure-JS sha256
// for the Node crypto-backed one. Alias it back to the fast Node implementation.
export default defineConfig({
  // Never pick up compiled output (dist/) — it duplicated every test file in
  // parallel runs and doubled the failure surface.
  test: {
    exclude: ["**/dist/**", "**/node_modules/**", "**/out/**"],
  },
  resolve: {
    alias: {
      "secure-remote-password/browser/sha256.js": "secure-remote-password/lib/sha256.js",
    },
  },
});
