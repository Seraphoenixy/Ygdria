/**
 * HTTP-level guarantees for sync data maintenance.
 *
 * These cover the contract the clients actually depend on: a peer that has no
 * cursor is told to re-baseline, a peer that only reads is still counted as
 * alive, and the snapshot endpoint keeps returning full state after the
 * incremental log has been pruned away.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  expireInactivePeers,
  getCursor,
  isPeerRebaselineRequired,
  type SqliteDatabase,
} from "@ygdria/database";
import { SYNC_REBASELINE_REQUIRED } from "@ygdria/shared";
import { buildApp } from "../app.js";

describe("sync maintenance endpoints", () => {
  let app: any;
  beforeAll(async () => {
    app = buildApp({ databaseUrl: ":memory:" });
  });
  afterAll(() => app.close());

  it("tells an unknown peer to re-baseline instead of inventing a cursor", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/sync/cursor?peerId=never-seen" });

    // advancedAt === null is the existing signal the web client uses to switch
    // from /sync/changes to /sync/snapshot.
    expect(res.json()).toMatchObject({ peerId: "never-seen", lastAdvanceId: 0, advancedAt: null, lastActiveAt: null });
    // Reading a cursor must not create one.
    const status = await app.inject({ method: "GET", url: "/api/v1/maintenance/sync-status" });
    expect(status.json().peers.some((p: any) => p.peerId === "never-seen")).toBe(false);
  });

  it("records liveness when a peer advances and when it merely reads", async () => {
    const head = (await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" })).json().maxChangeId;
    const advanced = await app.inject({
      method: "POST",
      url: "/api/v1/sync/advance",
      payload: { peerId: "desktop", cursor: head },
    });
    expect(advanced.json()).toMatchObject({ peerId: "desktop", lastAdvanceId: head });
    expect(advanced.json().lastActiveAt).toBeGreaterThan(0);

    const cursor = (await app.inject({ method: "GET", url: "/api/v1/sync/cursor?peerId=desktop" })).json();
    expect(cursor).toMatchObject({ peerId: "desktop", lastAdvanceId: head });
    // A caught-up device never advances again; reading is what keeps it alive.
    expect(cursor.lastActiveAt).toBeGreaterThanOrEqual(cursor.advancedAt);
  });

  it("keeps the snapshot baseline complete after the change log is pruned", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Survives pruning" } })
    ).json();

    // A single peer that is fully caught up lets /advance prune the whole log.
    const head = (await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" })).json().maxChangeId;
    await app.inject({ method: "POST", url: "/api/v1/sync/advance", payload: { peerId: "desktop", cursor: head } });

    const incremental = (await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0" })).json();
    expect(incremental.changes).toHaveLength(0);

    // Offline recovery is untouched: the note is still reachable in full.
    const snapshot = (
      await app.inject({ method: "GET", url: "/api/v1/sync/snapshot?cursor=0&limit=500&metadataOnly=1" })
    ).json();
    expect(snapshot.changes.some((c: any) => c.entityType === "note" && c.entityId === note.id)).toBe(true);
  });

  it("reports capacity and peer state read-only", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/v1/maintenance/sync-status" })).json();

    expect(before.stats).toMatchObject({
      changeLog: expect.any(Object),
      tombstones: expect.any(Object),
      peers: expect.any(Object),
      storageCleanupJobs: expect.any(Object),
      database: expect.any(Object),
    });
    expect(before.stats.thresholds.peerMaxInactiveMs).toBeGreaterThan(0);
    expect(before.stats.warnings).toEqual([]);
    const desktop = before.peers.find((p: any) => p.peerId === "desktop");
    expect(desktop).toMatchObject({ expired: false });

    // Calling it again changes nothing.
    const after = (await app.inject({ method: "GET", url: "/api/v1/maintenance/sync-status" })).json();
    expect(after.stats.changeLog.rows).toBe(before.stats.changeLog.rows);
    expect(after.peers).toHaveLength(before.peers.length);
  });

  it("exposes the last maintenance run once the runner has executed", async () => {
    const started = await app.inject({ method: "POST", url: "/api/v1/maintenance/database" });
    expect(started.statusCode).toBe(200);
    // The in-memory runner defers to the next event-loop turn.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const task = (await app.inject({ method: "GET", url: "/api/v1/maintenance/status" })).json().task;
    expect(task.status).toBe("succeeded");
    expect(task.result).toMatchObject({
      expiredSyncPeers: 0,
      removedTombstones: expect.any(Number),
      removedStorageCleanupJobs: expect.any(Number),
      syncWarnings: [],
    });

    const status = (await app.inject({ method: "GET", url: "/api/v1/maintenance/sync-status" })).json();
    expect(status.lastRun).not.toBeNull();
    expect(status.lastRun.capturedAt).toBeGreaterThan(0);
    // The active peer kept its cursor through a full maintenance pass.
    expect(status.peers.some((p: any) => p.peerId === "desktop")).toBe(true);
  });
});

/**
 * Peer liveness and the re-baseline gate, end to end over HTTP.
 *
 * A file-backed database lets the test open a second connection and play the
 * part of time passing (backdating a peer's activity) and of the nightly
 * maintenance pass, without waiting ninety days.
 */
describe("peer liveness and the re-baseline gate", () => {
  const DAY = 24 * 60 * 60 * 1000;
  let dir: string;
  let app: any;
  let db: SqliteDatabase;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ygdria-sync-gate-"));
    app = buildApp({ databaseUrl: join(dir, "gate.db") });
    db = createDatabase(join(dir, "gate.db")).sqlite;
  });
  afterAll(async () => {
    db.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Pretend the peer has said nothing for `ms`. */
  const silence = (peerId: string, ms: number) => {
    const at = Date.now() - ms;
    db.prepare("UPDATE sync_cursors SET advanced_at=?,last_active_at=? WHERE peer_id=?").run(at, at, peerId);
  };
  const register = async (peerId: string, cursor = 0) =>
    app.inject({ method: "POST", url: "/api/v1/sync/advance", payload: { peerId, cursor } });
  const head = async () =>
    (await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&metadataOnly=1" })).json().maxChangeId;

  it("keeps a pull-only peer alive", async () => {
    await register("puller", await head());
    silence("puller", 200 * DAY);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sync/changes?cursor=0&metadataOnly=1&peerId=puller",
    });

    expect(res.statusCode).toBe(200);
    // A device that is permanently up to date never calls /advance. Pulling is
    // what proves it is alive, so it must not be expired for being quiet.
    expect(getCursor(db, "puller")!.lastActiveAt).toBeGreaterThan(Date.now() - 60_000);
    expect(expireInactivePeers(db, { maxInactiveMs: 90 * DAY })).toEqual([]);
    expect(getCursor(db, "puller")).not.toBeNull();
  });

  it("keeps a push-only peer alive", async () => {
    await register("pusher", await head());
    silence("pusher", 200 * DAY);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      payload: { changes: [], peerId: "pusher" },
    });

    expect(res.statusCode).toBe(200);
    expect(getCursor(db, "pusher")!.lastActiveAt).toBeGreaterThan(Date.now() - 60_000);
    expect(expireInactivePeers(db, { maxInactiveMs: 90 * DAY })).toEqual([]);
  });

  it("keeps a peer alive that only reads its cursor or the snapshot", async () => {
    await register("reader", await head());

    silence("reader", 200 * DAY);
    expect((await app.inject({ method: "GET", url: "/api/v1/sync/cursor?peerId=reader" })).statusCode).toBe(200);
    expect(getCursor(db, "reader")!.lastActiveAt).toBeGreaterThan(Date.now() - 60_000);

    silence("reader", 200 * DAY);
    const snapshot = await app.inject({
      method: "GET",
      url: "/api/v1/sync/snapshot?cursor=0&limit=1&metadataOnly=1&peerId=reader",
    });
    expect(snapshot.statusCode).toBe(200);
    expect(getCursor(db, "reader")!.lastActiveAt).toBeGreaterThan(Date.now() - 60_000);

    expect(expireInactivePeers(db, { maxInactiveMs: 90 * DAY })).toEqual([]);
  });

  it("still refuses to invent a cursor for an unknown or unnamed peer", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&metadataOnly=1" });
    expect(anonymous.statusCode).toBe(200);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/sync/changes?cursor=0&metadataOnly=1&peerId=stranger",
    });
    expect(unknown.statusCode).toBe(200);

    expect(getCursor(db, "stranger")).toBeNull();
    // Missing peerId keeps its existing validation on the endpoints that
    // require it.
    expect((await app.inject({ method: "GET", url: "/api/v1/sync/cursor" })).statusCode).toBe(400);
  });

  it("gates a peer that has gone silent past the expiry window", async () => {
    await register("gated", await head());
    silence("gated", 400 * DAY);

    expect(expireInactivePeers(db, { maxInactiveMs: 90 * DAY })).toEqual(["gated"]);
    expect(isPeerRebaselineRequired(db, "gated")).toBe(true);

    // The gate is visible to operators even though the cursor row is gone.
    const status = (await app.inject({ method: "GET", url: "/api/v1/maintenance/sync-status" })).json();
    expect(status.peers).toContainEqual(
      expect.objectContaining({ peerId: "gated", expired: true, rebaselineRequired: true }),
    );
    expect(status.stats.peers.rebaselineRequired).toBe(1);
  });

  it("refuses an incremental pull from a gated peer", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&peerId=gated" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(SYNC_REBASELINE_REQUIRED);
  });

  it("refuses a push from a gated peer, so it cannot seed stale state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      payload: {
        peerId: "gated",
        changes: [
          {
            entityType: "setting",
            entityId: "gated-write",
            changeKind: "updated",
            data: { key: "gated-write", value: "stale", updatedAt: Date.now() },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(SYNC_REBASELINE_REQUIRED);
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key='gated-write'").get()).toEqual({ c: 0 });
  });

  it("tells a gated peer to re-baseline as soon as it reads its cursor", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/sync/cursor?peerId=gated" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(SYNC_REBASELINE_REQUIRED);
  });

  it("lets a gated peer rebuild from the snapshot and resume incremental sync", async () => {
    // The snapshot is the one path that stays open: it is the way out.
    const snapshot = await app.inject({
      method: "GET",
      url: "/api/v1/sync/snapshot?cursor=0&limit=500&metadataOnly=1&peerId=gated",
    });
    expect(snapshot.statusCode).toBe(200);
    // Downloading is not finishing: the gate holds until the cursor is confirmed.
    expect(isPeerRebaselineRequired(db, "gated")).toBe(true);

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/sync/advance",
      payload: { peerId: "gated", cursor: snapshot.json().maxChangeId },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(isPeerRebaselineRequired(db, "gated")).toBe(false);

    // Normal incremental sync is back, on a fresh cursor at the snapshot head.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&metadataOnly=1&peerId=gated" }))
        .statusCode,
    ).toBe(200);
    const cursor = await app.inject({ method: "GET", url: "/api/v1/sync/cursor?peerId=gated" });
    expect(cursor.statusCode).toBe(200);
    expect(cursor.json()).toMatchObject({ peerId: "gated", lastAdvanceId: snapshot.json().maxChangeId });
  });

  it("does not let a gated peer bypass the snapshot with /advance", async () => {
    await register("forged", await head());
    silence("forged", 400 * DAY);
    expect(expireInactivePeers(db, { maxInactiveMs: 90 * DAY })).toEqual(["forged"]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/advance",
      payload: { peerId: "forged", cursor: await head() },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(SYNC_REBASELINE_REQUIRED);
    expect(isPeerRebaselineRequired(db, "forged")).toBe(true);
  });

  it("never resurrects a permanently deleted note, even from an unidentified peer", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Doomed" } })
    ).json();
    // Capture the note exactly as a peer would have replicated it, then age it
    // so the copy is unambiguously older than the deletion.
    const pulled = (await app.inject({ method: "GET", url: "/api/v1/sync/changes?cursor=0&limit=500" })).json();
    const replica = pulled.changes.find((c: any) => c.entityType === "note" && c.entityId === note.id);
    expect(replica).toBeDefined();
    replica.createdAt = Date.now() - 60_000;
    replica.data.updatedAt = Date.now() - 60_000;

    // The user purges the note while that peer is away.
    await app.inject({ method: "DELETE", url: `/api/v1/notes/${note.id}` });
    await app.inject({ method: "DELETE", url: `/api/v1/notes/${note.id}/permanent` });
    expect(db.prepare("SELECT COUNT(*) c FROM notes WHERE id=?").get(note.id)).toEqual({ c: 0 });
    expect(
      db.prepare("SELECT COUNT(*) c FROM sync_tombstones WHERE entity_type='note' AND entity_id=?").get(note.id),
    ).toEqual({ c: 1 });

    // It comes back and pushes its stale copy with no peerId at all — the
    // oldest possible client, entirely outside the gate. The tombstone still
    // wins: gating is the first line of defence, not the only one.
    const res = await app.inject({ method: "POST", url: "/api/v1/sync/push", payload: { changes: [replica] } });

    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM notes WHERE id=?").get(note.id)).toEqual({ c: 0 });
  });
});
