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

describe("snapshot permanent note deletions", () => {
  it("replays a purge after log pruning without deleting unrelated or newer local notes", async () => {
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();
    const headers = { "x-ygdria-local-token": "snapshot-test", "x-ygdria-sync-origin": "remote" };
    const client = buildApp({ databaseUrl: ":memory:", localToken: "snapshot-test" });
    await client.ready();
    clock.mockReturnValue(start + 1_000);
    const server = buildApp({ databaseUrl: ":memory:" });
    const sessions: string[] = [];
    type SnapshotChange = {
      entityType: string;
      entityId: string;
      changeKind: string;
      data: unknown;
    };
    async function downloadSnapshot(peerId: string, source = server) {
      const session = randomUUID();
      sessions.push(session);
      const changes: SnapshotChange[] = [];
      const presentIds = new Set<string>();
      let generation = 0;
      let cursor = 0;
      for (;;) {
        const response = await source.inject({
          url: `/api/v1/sync/snapshot?session=${session}&peerId=${peerId}&cursor=${cursor}&limit=3`,
        });
        expect(response.statusCode, response.body).toBe(200);
        const page = response.json();
        changes.push(...page.changes);
        generation = page.generation ?? generation;
        for (const change of page.changes as SnapshotChange[])
          if (change.entityType === "note" && change.changeKind !== "deleted")
            presentIds.add(change.entityId);
        const applied = await client.inject({
          method: "POST",
          url: "/api/v1/sync/push",
          headers,
          payload: { changes: page.changes, sourcePeer: peerId },
        });
        expect(applied.statusCode, applied.body).toBe(200);
        if (!page.hasMore) {
          const reconciled = await client.inject({
            method: "POST",
            url: "/api/v1/sync/reconcile",
            headers,
            payload: {
              peerId,
              presentIds: [...presentIds],
              recoverySuffix: "recovered",
              generation,
            },
          });
          expect(reconciled.statusCode, reconciled.body).toBe(200);
          return {
            changes,
            maxChangeId: page.maxChangeId,
            recovered: reconciled.json().recovered as string[],
          };
        }
        cursor = page.cursor;
      }
    }
    const trash = (app: typeof client, id: string) =>
      app.inject({
        url: `/api/v1/trash/${id}`,
        headers,
      });
    try {
      const create = async (title: string) =>
        (
          await server.inject({
            method: "POST",
            url: "/api/v1/notes",
            payload: { title },
          })
        ).json();
      const purged = await create("Replicated in trash");
      const active = await create("Still active on client");
      const edited = await create("Edited offline");
      const firstServerOnly = await create("From the first server");
      const local = (
        await client.inject({
          method: "POST",
          url: "/api/v1/notes",
          headers,
          payload: { title: "Local only" },
        })
      ).json();
      const original = await downloadSnapshot("first");
      const stale = original.changes.find(
        (change) => change.entityId === purged.id && change.entityType === "note",
      );
      expect(stale).toBeDefined();

      clock.mockReturnValue(start + 2_000);
      expect(
        (await server.inject({ method: "DELETE", url: `/api/v1/notes/${purged.id}` })).statusCode,
      ).toBe(200);
      await downloadSnapshot("first");
      expect((await trash(client, purged.id)).statusCode).toBe(200);
      for (const id of [purged.id, active.id, edited.id]) {
        expect(
          (await server.inject({ method: "DELETE", url: `/api/v1/notes/${id}/permanent` }))
            .statusCode,
        ).toBe(200);
      }
      const head = (await server.inject({ url: "/api/v1/sync/changes" })).json().maxChangeId;
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/api/v1/sync/advance",
            payload: { peerId: "caught-up", cursor: head },
          })
        ).statusCode,
      ).toBe(200);
      expect((await server.inject({ url: "/api/v1/sync/changes" })).json().changes).toEqual([]);

      clock.mockReturnValue(start + 3_000);
      const edit = await client.inject({
        method: "PATCH",
        url: `/api/v1/notes/${edited.id}`,
        headers,
        payload: { title: "New local edit", expectedVersion: edited.version },
      });
      expect(edit.statusCode, edit.body).toBe(200);

      const recovered = await downloadSnapshot("first");
      expect(recovered.maxChangeId).toBe(head);
      expect(recovered.changes).not.toContainEqual(
        expect.objectContaining({
          entityType: "note",
          entityId: purged.id,
          changeKind: "deleted",
        }),
      );
      expect((await trash(client, purged.id)).statusCode).toBe(404);
      expect((await trash(client, active.id)).statusCode).toBe(404);
      expect((await client.inject({ url: `/api/v1/notes/${edited.id}`, headers })).statusCode).toBe(
        404,
      );
      expect(recovered.recovered).toHaveLength(2);
      const recoveredTitles = await Promise.all(
        recovered.recovered.map(
          async (id) => (await client.inject({ url: `/api/v1/notes/${id}`, headers })).json().title,
        ),
      );
      expect(recoveredTitles).toEqual(
        expect.arrayContaining(["New local edit recovered", "Local only recovered"]),
      );
      expect(
        (
          await client.inject({
            method: "POST",
            url: "/api/v1/sync/advance",
            headers,
            payload: { peerId: "in:remote", cursor: recovered.maxChangeId },
          })
        ).statusCode,
      ).toBe(200);
      const pending = (await client.inject({ url: "/api/v1/sync/changes", headers })).json()
        .changes;
      expect(pending).toContainEqual(
        expect.objectContaining({ entityId: local.id, changeKind: "deleted" }),
      );
      for (const id of recovered.recovered)
        expect(pending).toContainEqual(
          expect.objectContaining({ entityId: id, entityType: "note" }),
        );
      await downloadSnapshot("first");
      expect((await trash(client, active.id)).statusCode).toBe(404);
      const replay = await client.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers,
        payload: { changes: [stale] },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().applied).toBe(0);
      expect((await client.inject({ url: `/api/v1/notes/${purged.id}`, headers })).statusCode).toBe(
        404,
      );
      const secondServer = buildApp({ databaseUrl: ":memory:" });
      try {
        await downloadSnapshot("switch", secondServer);
        expect(
          (await client.inject({ url: `/api/v1/notes/${firstServerOnly.id}`, headers })).json()
            .title,
        ).toBe("From the first server");
      } finally {
        await secondServer.close();
      }
    } finally {
      for (const session of sessions) snapshotCache.release(session);
      await Promise.all([client.close(), server.close()]);
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
