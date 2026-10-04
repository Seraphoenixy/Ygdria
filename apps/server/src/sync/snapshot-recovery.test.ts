import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../app.js";
import { createDatabase, applyMigrations } from "@ygdria/database";
import { snapshotCache, SnapshotCache } from "./helpers.js";
afterEach(() => vi.restoreAllMocks());
describe("snapshot recovery", () => {
  it("rejects a missing continuation instead of silently creating another snapshot", async () => {
    const app = buildApp({ databaseUrl: ":memory:" });
    const session = randomUUID();
    try {
      const first = (
        await app.inject({ method: "GET", url: `/api/v1/sync/snapshot?session=${session}&limit=1` })
      ).json();
      snapshotCache.release(session);
      const next = await app.inject({
        method: "GET",
        url: `/api/v1/sync/snapshot?session=${session}&cursor=${first.cursor}&limit=1`,
      });
      expect(next.statusCode).toBe(409);
      expect(next.json().error.code).toBe("SYNC_SNAPSHOT_EXPIRED");
    } finally {
      snapshotCache.release(session);
      await app.close();
    }
  });
  it("never serves a live body when a requested snapshot session has disappeared", async () => {
    const app = buildApp({ databaseUrl: ":memory:" });
    const session = randomUUID();
    try {
      const note = (
        await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Pinned" } })
      ).json();
      const snap = (
        await app.inject({ method: "GET", url: `/api/v1/sync/snapshot?session=${session}` })
      ).json();
      const data = snap.changes.find((c: any) => c.entityId === note.id).data;
      snapshotCache.release(session);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sync/notes/content/batch",
        payload: { session, ids: [note.id], hashes: [data.contentHash] },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      snapshotCache.release(session);
      await app.close();
    }
  });
  it("expires idle sessions even if no new session is created", async () => {
    const app = buildApp({ databaseUrl: ":memory:" });
    const session = randomUUID();
    try {
      await app.inject({ method: "GET", url: `/api/v1/sync/snapshot?session=${session}` });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
      expect(() => snapshotCache.getNoteContents(session, [], [])).toThrow();
    } finally {
      snapshotCache.release(session);
      await app.close();
    }
  });
});

describe("snapshot resource lifecycle", () => {
  it("releases bodies only after the client confirms the snapshot cursor", async () => {
    const app = buildApp({ databaseUrl: ":memory:" });
    const session = randomUUID();
    try {
      const snapshot = (
        await app.inject({
          method: "GET",
          url: `/api/v1/sync/snapshot?session=${session}&peerId=resource-reader`,
        })
      ).json();
      expect(() => snapshotCache.getNoteContents(session, [], [])).not.toThrow();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sync/advance",
        payload: {
          peerId: "resource-reader",
          cursor: snapshot.maxChangeId,
          snapshotSession: session,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(() => snapshotCache.getNoteContents(session, [], [])).toThrow();
    } finally {
      snapshotCache.release(session);
      await app.close();
    }
  });
  it("enforces a byte budget rather than just a session count", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    try {
      const cache = new (SnapshotCache as any)({ maxBytes: 1 });
      expect(() => cache.getOrCreate(randomUUID(), db.sqlite, "")).toThrow();
    } finally {
      db.sqlite.close();
    }
  });
  it("indexes notes once instead of scanning the entire snapshot for every body request", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    try {
      const cache = new SnapshotCache();
      const id = randomUUID();
      const session = cache.getOrCreate(id, db.sqlite, "");
      const scan = vi.spyOn(session.changes, "filter");
      cache.getNoteContents(id, [], []);
      cache.getNoteContents(id, [], []);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      db.sqlite.close();
    }
  });
});
