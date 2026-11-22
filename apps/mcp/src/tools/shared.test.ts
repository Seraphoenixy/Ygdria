import assert from "node:assert/strict";
import test from "node:test";
import { EtapiError } from "../client/etapi-client.js";
import { versionConflict } from "./shared.js";

test("versionConflict returns the latest note for a recoverable write conflict", async () => {
  const result = await versionConflict({
    async getNote() {
      return { id: "note-1", version: 8, content: "Latest" };
    },
  }, "note-1");

  assert.equal(result.isError, true);
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  assert.deepEqual(JSON.parse(content.text), {
    error: "version_conflict",
    message:
      "The note changed. Re-evaluate the requested edit against this latest state; do not retry the old version.",
    latest: { id: "note-1", version: 8, content: "Latest" },
  });
});

test("versionConflict reports a latest-note read failure", async () => {
  const result = await versionConflict({
    async getNote() {
      throw new EtapiError(404, "missing");
    },
  }, "note-1");

  assert.equal(result.isError, true);
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  assert.equal(JSON.parse(content.text).message, "missing");
  assert.equal(JSON.parse(content.text).status, 404);
});
