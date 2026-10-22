import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assertSecureNode } from "./node-security.mjs";

test("release runtime rejects old, unsupported and prerelease Node versions", () => {
  for (const version of [
    "24.18.0",
    "24.21.0",
    "24.22.0",
    "22.23.4",
    "25.0.0",
    "24.22.1-rc.1",
    "invalid",
  ]) {
    assert.throws(() => assertSecureNode(version));
  }
  for (const version of ["24.22.1", "24.22.2", "24.23.0"]) {
    assert.doesNotThrow(() => assertSecureNode(version));
  }
});

test("local and CI runtime pins agree with the security floor", () => {
  const version = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  assertSecureNode(version);
  const workflow = readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes(`NODE_VERSION: "${version}"`));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, `>=${version} <25.0.0`);
});
