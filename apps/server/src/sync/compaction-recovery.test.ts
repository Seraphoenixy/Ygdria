import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { YgdriaClient } from "@ygdria/api-client";
import { createDatabase, runSyncDataMaintenance } from "@ygdria/database";
import { NoteService } from "@ygdria/domain";
import { buildApp } from "../app.js";

describe("compaction recovery across running replicas", () => {
  it("reconciles snapshot absence and uploads preserved offline content under a new identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ygdria-two-replicas-"));
    const remotePath = join(root, "remote.db");
    const local = buildApp({ databaseUrl: join(root, "local.db"), maintenanceIntervalMs: 0 });
    const remote = buildApp({ databaseUrl: remotePath, maintenanceIntervalMs: 0 });
    try {
      const localUrl = await local.listen({ host: "127.0.0.1", port: 0 });
      const remoteUrl = await remote.listen({ host: "127.0.0.1", port: 0 });
      const localClient = new YgdriaClient(localUrl);
      const remoteClient = new YgdriaClient(remoteUrl);
      const note = await localClient.createNote({
        title: "shared",
        type: "code",
        code: "common base",
      });
      const outgoing = await localClient.syncChanges(0, 500);
      await remoteClient.pushSyncChanges(outgoing.changes);
      await localClient.advanceSyncCursor(`out:${remoteUrl}`, outgoing.cursor);
      await localClient.updateNote(note.id, {
        code: "offline edit",
        expectedVersion: note.version,
      });
      const unsent = await localClient.createNote({
        title: "unsent",
        type: "code",
        code: "new offline content",
      });
      const db = createDatabase(remotePath).sqlite;
      try {
        const notes = new NoteService({ sqlite: db });
        notes.remove(note.id);
        notes.purge(note.id);
        const result = runSyncDataMaintenance(db, { now: Date.now() + 40 * 86_400_000 });
        expect(result.removedTombstones).toBe(0);
        expect(db.prepare("SELECT COUNT(*) c FROM sync_tombstones").get()).toEqual({ c: 0 });
      } finally {
        db.close();
      }
      const snapshot = await remoteClient.syncSnapshot(0, 500);
      expect(snapshot.authoritative).toBe(true);
      await localClient.pushSyncChanges(
        snapshot.changes,
        "remote",
        undefined,
        undefined,
        remoteUrl,
      );
      const present = snapshot.changes
        .filter((change) => change.entityType === "note" && change.changeKind !== "deleted")
        .map((change) => change.entityId);
      const reconciled = await localClient.reconcileSnapshot(
        remoteUrl,
        present,
        "recovered",
        snapshot.generation,
      );
      expect(reconciled.recovered).toHaveLength(2);
      await expect(localClient.getNote(unsent.id)).rejects.toMatchObject({ statusCode: 404 });
      const recoveredContents = await Promise.all(
        reconciled.recovered.map(async (id) => (await localClient.getNote(id)).content),
      );
      expect(recoveredContents).toEqual(
        expect.arrayContaining(["offline edit", "new offline content"]),
      );
      const cursor = await localClient.getSyncCursor(`out:${remoteUrl}`);
      const pending = await localClient.syncChanges(cursor.lastAdvanceId, 500);
      await remoteClient.pushSyncChanges(pending.changes);
      await expect(remoteClient.getNote(note.id)).rejects.toMatchObject({ statusCode: 404 });
      const remoteContents = await Promise.all(
        reconciled.recovered.map(async (id) => (await remoteClient.getNote(id)).content),
      );
      expect(remoteContents).toEqual(
        expect.arrayContaining(["offline edit", "new offline content"]),
      );
    } finally {
      await local.close();
      await remote.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
