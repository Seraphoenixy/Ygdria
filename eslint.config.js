// ESLint flat config — Ygdria web app.
//
// Adds a custom rule that flags hardcoded Chinese (CJK) string literals which
// bypass the i18n `t()` system, so user-facing copy cannot silently regress to
// untranslated text. The web app's translation dictionary lives in
// apps/web/src/lib/i18n.ts (excluded below — the dictionary itself is the
// source of truth for Chinese strings, and its keys are ASCII).
//
// Activation: `pnpm install` (pulls typescript-eslint / @eslint/js / globals),
// then `pnpm lint`. The rule is a *warning* so it never blocks the build; it
// surfaces leaks in editor/CI for follow-up.
//
// Mirrors scripts/check-i18n.mjs (same guard, runnable without this config).

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const noHardcodedCjk = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hardcoded CJK string literals that bypass the i18n t() system.",
    },
    schema: [],
    messages: {
      hardcoded:
        "Hardcoded Chinese string '{{value}}' should go through the i18n t() system instead of a literal.",
    },
  },
  create(context) {
    const CJK = /[㐀-鿿]/;
    const source = context.sourceCode;
    function calleeName(node) {
      if (!node) return null;
      if (node.type === "Identifier") return node.name;
      if (node.type === "MemberExpression") return node.property?.name ?? null;
      return null;
    }
    function isLocalizedCall(node) {
      const parent = node.parent;
      if (!parent || parent.type !== "CallExpression" || !parent.callee) return false;
      const name = calleeName(parent.callee);
      return name === "t" || name === "translate" || name === "i18n";
    }
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (!CJK.test(node.value)) return;
        if (isLocalizedCall(node)) return;
        const lineText = source.lines[node.loc.start.line - 1] ?? "";
        if (lineText.includes("i18n-ignore")) return;
        context.report({
          node,
          messageId: "hardcoded",
          data: { value: node.value.slice(0, 24) },
        });
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          if (!CJK.test(quasi.value.raw)) continue;
          if (isLocalizedCall(node)) return;
          const lineText = source.lines[node.loc.start.line - 1] ?? "";
          if (lineText.includes("i18n-ignore")) return;
          context.report({
            node: quasi,
            messageId: "hardcoded",
            data: { value: quasi.value.raw.slice(0, 24) },
          });
          return;
        }
      },
    };
  },
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/*.css",
      "**/*.test.*",
      "**/*.spec.*",
      "**/i18n.ts",
    ],
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      globals: { ...globals.browser },
    },
    plugins: {
      "ygdria-i18n": { rules: { "no-hardcoded-cjk": noHardcodedCjk } },
    },
    rules: {
      "ygdria-i18n/no-hardcoded-cjk": "warn",
    },
  },
];
