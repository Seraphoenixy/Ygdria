import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseIni } from "./config.js";

test("defaults to loopback without tokens or write settings", () => {
  assert.deepEqual(
    loadConfig({ YGDRIA_CONFIG_FILE: join(tmpdir(), "ygdria-no-config.ini") }),
    { baseUrl: "http://127.0.0.1:4318" },
  );
});
test("reads an optional URL and ignores retired credential settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "ygdria-config-"));
  const file = join(dir, "config.ini");
  try {
    writeFileSync(
      file,
      "[etapi]\nurl=http://localhost:4319\ntoken=legacy-secret\nallowWrite=false",
    );
    assert.deepEqual(loadConfig({ YGDRIA_CONFIG_FILE: file }), {
      baseUrl: "http://localhost:4319",
    });
    assert.deepEqual(parseIni("[etapi]\ntoken=legacy\nallowWrite=true"), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("rejects remote hosts and non-origin URLs", () => {
  for (const url of [
    "https://example.com",
    "http://127.0.0.1/api/v1",
    "http://user:pass@localhost",
    "http://localhost/?q=x",
    "file:///localhost",
  ])
    assert.throws(() => loadConfig({ YGDRIA_ETAPI_URL: url }));
  assert.deepEqual(loadConfig({ YGDRIA_ETAPI_URL: "http://[::1]:4318" }), {
    baseUrl: "http://[::1]:4318",
  });
});
