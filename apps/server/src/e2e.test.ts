/**
 * End-to-end tests for incremental sync, maintenance mutex, and /ready.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { buildApp } from "./app.js";

function createApp() {
  return buildApp({ databaseUrl: ":memory:" });
}

describe("incremental sync", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it("returns the initial synced settings from a fresh database", async () => {
    const app = createApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&limit=50" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ entityType: "setting", entityId: "content_schema_version", changeKind: "updated" });
    expect(body.cursor).toBeGreaterThan(0);
    expect(body.hasMore).toBe(false);
    expect(body.maxChangeId).toBeGreaterThanOrEqual(0);
  });

  it("returns changes after creating a note", async () => {
    const app = createApp();
    apps.push(app);
    // Create a note.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/notes",
      payload: { title: "Sync test note", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] } },
    });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id;

    // Query changes from cursor 0.
    const res = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&limit=50" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changes.length).toBeGreaterThan(0);
    const noteChange = body.changes.find((c: { entityType: string; entityId: string }) => c.entityType === "note" && c.entityId === noteId);
    expect(noteChange).toBeDefined();
    expect(noteChange.changeKind).toBe("created");
    expect(noteChange.data).toHaveProperty("title", "Sync test note");
  });

  it("advances cursor and returns only new changes", async () => {
    const app = createApp();
    apps.push(app);
    // Create first note.
    await app.inject({
      method: "POST",
      url: "/api/v1/notes",
      payload: { title: "First note" },
    });
    // Get changes and advance cursor.
    const firstBatch = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" });
    const firstCursor = firstBatch.json().cursor;

    const advanceRes = await app.inject({
      method: "POST",
      url: "/api/v1/sync/advance",
      payload: { peerId: "test-peer", cursor: firstCursor },
    });
    expect(advanceRes.statusCode).toBe(200);

    // Create second note.
    await app.inject({
      method: "POST",
      url: "/api/v1/notes",
      payload: { title: "Second note" },
    });

    // Query changes from the advanced cursor — should only get the second note.
    const secondBatch = await app.inject({ method: "GET", url: `/api/v1/sync/changes?cursor=${firstCursor}` });
    const changes = secondBatch.json().changes;
    const hasFirstNote = changes.some((c: { entityId: string; data: { title: string } | null }) => c.data?.title === "First note");
    const hasSecondNote = changes.some((c: { entityId: string; data: { title: string } | null }) => c.data?.title === "Second note");
    expect(hasFirstNote).toBe(false);
    expect(hasSecondNote).toBe(true);
  });

  it("validates cursor and peerId on advance", async () => {
    const app = createApp();
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/advance",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("applies pushed note changes with last-write-wins semantics", async () => {
    const source = createApp();
    const target = createApp();
    apps.push(source, target);
    const created = await source.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "central" } });
    const changes = (await source.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" })).json().changes;
    const pushed = await target.inject({ method: "POST", url: "/api/v1/sync/push", payload: { changes } });
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json().applied).toBeGreaterThan(0);
    expect((await target.inject(`/api/v1/notes/${created.json().id}`)).json().title).toBe("central");
    expect((await target.inject("/api/v1/search?q=central")).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ noteId: created.json().id })]),
    );
  });

  it("coalesces repeated edits and returns only the latest note snapshot", async () => {
    const app = createApp();
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "draft" } });
    const note = created.json();
    const first = await app.inject({ method: "PATCH", url: `/api/v1/notes/${note.id}`, payload: { title: "middle", expectedVersion: note.version } });
    await app.inject({ method: "PATCH", url: `/api/v1/notes/${note.id}`, payload: { title: "final", expectedVersion: first.json().version } });

    const response = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&metadataOnly=1" });
    const body = response.json();
    const changes = body.changes.filter((change: { entityType: string; entityId: string }) => change.entityType === "note" && change.entityId === note.id);
    expect(changes).toHaveLength(1);
    expect(changes[0].data.title).toBe("final");
    expect(changes[0].data).not.toHaveProperty("contentData");
    expect(body.stats.coalescedChanges).toBeGreaterThanOrEqual(2);
  });

  it("stops a pull batch at the serialized byte limit and leaves a resumable cursor", async () => {
    const app = createApp();
    apps.push(app);
    for (let index = 0; index < 180; index += 1)
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: `batch-${index}` } });

    const response = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&limit=500&maxBytes=65536&metadataOnly=1" });
    const body = response.json();
    expect(body.hasMore).toBe(true);
    expect(body.changes.length).toBeLessThan(361);
    expect(body.stats.serializedBytes).toBeLessThanOrEqual(65536);
    expect(body.stats.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(body.cursor).toBeGreaterThan(0);
  });

  it("replicates revision history together with its note", async () => {
    const source = createApp();
    const target = createApp();
    apps.push(source, target);
    const created = await source.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "history", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }] } } });
    const updated = await source.inject({
      method: "PATCH",
      url: `/api/v1/notes/${created.json().id}`,
      payload: { expectedVersion: 1, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "after" }] }] } },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const changes = (await source.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" })).json().changes;
    expect(changes.some((change: { entityType: string }) => change.entityType === "revision")).toBe(true);
    const pushed = await target.inject({ method: "POST", url: "/api/v1/sync/push", payload: { changes } });
    expect(pushed.statusCode, pushed.body).toBe(200);
    const revisions = await target.inject(`/api/v1/notes/${created.json().id}/revisions`);
    expect(revisions.statusCode, revisions.body).toBe(200);
    expect(revisions.json()).toHaveLength(1);
  });

  it("never exports or imports authentication and protected-session settings", async () => {
    const source = createApp();
    const target = createApp();
    apps.push(source, target);
    expect((await source.inject({
      method: "POST", url: "/api/v1/protected-session/setup",
      payload: { salt: "private-salt", verifier: "private-verifier" },
    })).statusCode).toBe(200);
    const changes = (await source.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" })).json().changes;
    expect(JSON.stringify(changes)).not.toContain("protected_session_");
    expect(JSON.stringify(changes)).not.toContain("private-verifier");

    const now = Date.now();
    const pushed = await target.inject({
      method: "POST", url: "/api/v1/sync/push",
      payload: {
        changes: [
          {
            changeId: 1, entityType: "setting", entityId: "protected_session_verifier",
            changeKind: "updated", createdAt: now,
            data: { key: "protected_session_verifier", value: "attacker-value", updatedAt: now },
          },
          // A malicious peer must not be able to disguise a sensitive key by
          // putting a harmless entity ID alongside a different payload key.
          {
            changeId: 2, entityType: "setting", entityId: "content_schema_version",
            changeKind: "updated", createdAt: now + 1,
            data: { key: "auth_srp_verifier", value: "attacker-value", updatedAt: now + 1 },
          },
        ],
      },
    });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().applied).toBe(0);
    expect((await target.inject("/api/v1/protected-session")).json().configured).toBe(false);
    expect((await target.inject("/api/v1/health")).json().authInitialized).toBe(false);
  });

  it("streams a binary attachment by hash without JSON/Base64 buffering", async () => {
    const app = createApp();
    apps.push(app);
    const note = await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "binary" } });
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}?noteId=${note.json().id}&filename=image.png`,
      headers: { "content-type": "application/octet-stream" },
      payload: data,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const downloaded = await app.inject({ method: "GET", url: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}` });
    expect(downloaded.statusCode).toBe(200);
    expect(Buffer.from(downloaded.rawPayload)).toEqual(data);
  });
});

describe("maintenance mutex", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it("starts a maintenance task and returns a task id", async () => {
    const app = createApp();
    apps.push(app);
    const res = await app.inject({ method: "POST", url: "/api/v1/maintenance/database" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
  });

  it("returns 409 when a task is already running", async () => {
    const app = createApp();
    apps.push(app);
    // Start first task.
    const first = await app.inject({ method: "POST", url: "/api/v1/maintenance/database" });
    expect(first.statusCode).toBe(200);
    // Try to start second task — should get 409.
    const second = await app.inject({ method: "POST", url: "/api/v1/maintenance/database" });
    expect(second.statusCode).toBe(409);
  });

  it("reports task status", async () => {
    const app = createApp();
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/v1/maintenance/database" });
    // For in-memory DBs, the task runs synchronously, so it should be done.
    // Wait a moment for the status to update.
    await new Promise((r) => setTimeout(r, 100));
    const statusRes = await app.inject({ method: "GET", url: "/api/v1/maintenance/status" });
    expect(statusRes.statusCode).toBe(200);
    const status = statusRes.json().task;
    expect(status).not.toBeNull();
    expect(["succeeded", "failed", "running", "queued"]).toContain(status.status);
  });

  it("rate-limits maintenance after a completed task", async () => {
    const app = createApp();
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/v1/maintenance/database" })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const repeated = await app.inject({ method: "POST", url: "/api/v1/maintenance/database" });
    expect(repeated.statusCode).toBe(429);
  });

  it("allows a search-index rebuild during the full-maintenance cooldown", async () => {
    const app = createApp();
    apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/v1/maintenance/database" })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await app.inject({ method: "POST", url: "/api/v1/maintenance/search-index" })).statusCode).toBe(200);
  });
});

describe("readiness probe", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it("returns 200 when the server is ready", async () => {
    const app = createApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("does not leak internal error details", async () => {
    const app = createApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    const body = res.json();
    // Should not contain 'errors' array with internal details.
    expect(body.errors).toBeUndefined();
  });

  it("/health remains available as liveness probe", async () => {
    const app = createApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});
