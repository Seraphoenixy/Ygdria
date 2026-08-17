// Scans apps/web/src for hardcoded Chinese (CJK) string literals that bypass
// the i18n t() system, so user-facing copy cannot silently regress to
// untranslated text. This replaces the eslint flat-config rule that previously
// lived in eslint.config.js, and is runnable without any lint dependencies.
//
// Usage: node scripts/check-i18n.mjs
//
// Guesses:
//   * Strings inside the translation dictionary (apps/web/src/lib/i18n.ts) are
//     the source of truth, so that file is skipped (its keys are ASCII and the
//     values are the intended Chinese strings).
//   * Recognizes the localizers t(), translate() and i18n() — string/template
//     literals passed directly as their argument are considered localized.
//   * A line annotated with `i18n-ignore` is skipped regardless.
//
// Exit code is non-zero when violations are found, so it can gate CI.

import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "web", "src");
const CJK = /[㐀-鿿]/;
const LOCALIZER = new Set(["t", "translate", "i18n"]);

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function isLocalizerCallee(callee) {
  if (!callee) return false;
  if (ts.isIdentifier(callee)) return LOCALIZER.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return LOCALIZER.has(callee.name.text);
  return false;
}

function extractText(node, sf) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += span.literal.text;
    return text;
  }
  return "";
}

function isStringNode(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

function walk(node, parent, sf, report) {
  if (isStringNode(node)) {
    const text = extractText(node, sf);
    if (CJK.test(text)) {
      const argOfLocalizer =
        parent !== null && ts.isCallExpression(parent) && isLocalizerCallee(parent.expression);
      if (!argOfLocalizer) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const lineText = sf.text.split("\n")[line] ?? "";
        if (!lineText.includes("i18n-ignore")) {
          report(`  ${sf.fileName}:${line + 1}  Hardcoded Chinese string '${text.slice(0, 24)}' should go through the i18n t() system instead of a literal.`);
        }
      }
    }
  }
  ts.forEachChild(node, (child) => walk(child, node, sf, report));
}

function scriptKindFor(file) {
  return /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

let violations = 0;
for (const file of collect(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (rel.endsWith("/i18n.ts")) continue;
  if (/\.(test|spec)\.[a-z0-9]+$/.test(file)) continue;

  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKindFor(file));
  walk(sf, null, sf, (message) => {
    console.error(message);
    violations += 1;
  });
}

if (violations > 0) {
  console.error(`\n${violations} hardcoded string(s) found outside the i18n system.`);
  process.exit(1);
}
console.log("OK: no hardcoded CJK strings outside the i18n system.");