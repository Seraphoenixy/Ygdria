import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDatabase,
  getMaxChangeId,
  recordChange,
  runSyncDataMaintenance,
  writeRetentionPolicy,
} from "@ygdria/database";
import { NoteService } from "@ygdria/domain";
import { buildApp } from "./app.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("server retention scheduling", () => {
  it("blocks legacy and unknown peers after tombstone retirement until a full snapshot is confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ygdria-protocol-"));
    roots.push(root);
    const path = join(root, "notes.db");
    const { sqlite } = createDatabase(path);
    applyMigrations(sqlite);
    sqlite
      .prepare(
        "INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at,change_log_id) VALUES('note','deleted',0,1)",
      )
      .run();
    runSyncDataMaintenance(sqlite);
    sqlite.close();
    const app = buildApp({ databaseUrl: path, maintenanceIntervalMs: 0 });
    // Isolate the replication gate from the SRP flow tested in devices.test.ts.
    app.addHook("onRequest", async (req) => {
      req.device = { id: "test-device", label: "test", createdAt: 0, lastActiveAt: 0 };
    });
    try {
      const legacy = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        payload: { peerId: "peer", changes: [] },
      });
      expect(legacy.statusCode).toBe(426);
      const headers = { "x-ygdria-sync-protocol": "2" };
      const forged = await app.inject({
        method: "POST",
        url: "/api/v1/sync/advance",
        headers,
        payload: { peerId: "peer", cursor: 1 },
      });
      expect(forged.statusCode).toBe(409);
      const early = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers,
        payload: { peerId: "peer", changes: [] },
      });
      expect(early.statusCode).toBe(409);
      const snapshot = await app.inject({
        method: "GET",
        url: "/api/v1/sync/snapshot?peerId=peer",
        headers,
      });
      expect(snapshot.json().authoritative).toBe(true);
      const confirmed = await app.inject({
        method: "POST",
        url: "/api/v1/sync/advance",
        headers,
        payload: { peerId: "peer", cursor: snapshot.json().maxChangeId },
      });
      expect(confirmed.statusCode).toBe(200);
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers,
        payload: { peerId: "peer", changes: [] },
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("runs without a browser, preserves reusable SQLite pages, and stops before database shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "ygdria-retention-"));
    roots.push(root);
    const path = join(root, "notes.db");
    const { sqlite } = createDatabase(path);
    applyMigrations(sqlite);
    const notes = new NoteService({ sqlite });
    const note = notes.create({ title: "expired" });
    notes.remove(note.id);
    writeRetentionPolicy(sqlite, {
      revisionLimit: 1,
      trashRetentionMs: 1,
      attachmentRetentionMs: 0,
    });
    sqlite.prepare("UPDATE notes SET deleted_at=? WHERE id=?").run(Date.now() - 1000, note.id);
    recordChange(sqlite, "note", "old-history", "deleted", 0);
    const head = getMaxChangeId(sqlite);
    sqlite.close();
    const app = buildApp({ databaseUrl: path, maintenanceIntervalMs: 10 });
    try {
      await app.ready();
      const check = createDatabase(path).sqlite;
      try {
        expect(check.prepare("SELECT 1 FROM notes WHERE id=?").get(note.id)).toBeUndefined();
        expect(
          check.prepare("SELECT 1 FROM sync_change_log WHERE entity_id='old-history'").get(),
        ).toBeUndefined();
        expect(getMaxChangeId(check)).toBeGreaterThanOrEqual(head);
      } finally {
        check.close();
      }
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/v1/maintenance/retention",
        payload: { revisionLimit: -2 },
      });
      expect(invalid.statusCode).toBe(400);
      const policy = await app.inject({ method: "GET", url: "/api/v1/maintenance/retention" });
      expect(policy.json().revisionLimit).toBe(1);
    } finally {
      await app.close();
    }
  });
});
