/**
 * Safety tests for replication-metadata maintenance.
 *
 * The point of every case below is the same: bounded growth must not cost a
 * guarantee. A peer either keeps its cursor *and* the log entries it still
 * needs, or it loses both and re-baselines from the snapshot. A tombstone is
 * only dropped once every remaining peer has provably consumed the deletion.
 * A cleanup job is only dropped once the file is actually gone.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS,
  STORAGE_CLEANUP_JOB_WARN_PENDING,
  SYNC_CHANGE_LOG_WARN_ROWS,
} from "@ygdria/shared";
import { applyMigrations } from "./migrations.js";
import {
  activeSyncBoundary,
  advanceCursor,
  canCompletePeerRebaseline,
  clearPeerRebaseline,
  countRebaselineRequired,
  expireInactivePeers,
  getCursor,
  getMaxChangeId,
  isPeerRebaselineRequired,
  listPeerCursors,
  listRebaselineRequiredPeers,
  markPeerSnapshotCompleted,
  pruneChangeLog,
  recordChange,
  touchPeerActivity,
} from "./sync-change-log.js";
import {
  collectSyncMaintenanceStats,
  pruneCompletedStorageCleanupJobs,
  pruneSyncTombstones,
  runSyncDataMaintenance,
} from "./sync-maintenance.js";

const DAY = 24 * 60 * 60 * 1000;
/** Fixed clock. Every timestamp a test cares about is pinned relative to it. */
const NOW = 1_800_000_000_000;
/**
 * A freshly migrated database is not empty: migration v10 records the
 * content-schema setting in the change log. Tests account for that row instead
 * of pretending the log starts at zero.
 */
const BASELINE_CHANGE_ROWS = 1;

function freshDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return sqlite;
}

/**
 * Advance a cursor and pin its timestamps. `advanceCursor` stamps the real
 * clock, which would otherwise look 100+ days stale next to the fixed NOW.
 */
function syncTo(sqlite: Database.Database, peerId: string, cursor: number, activeAt = NOW) {
  advanceCursor(sqlite, peerId, cursor);
  // Test fixture shortcut: model a peer that already completed its snapshot.
  // Production clears this only through the server's observed-snapshot gate.
  clearPeerRebaseline(sqlite, peerId);
  sqlite
    .prepare("UPDATE sync_cursors SET advanced_at=?,last_active_at=? WHERE peer_id=?")
    .run(activeAt, activeAt, peerId);
  return cursor;
}

function changeLogIds(sqlite: Database.Database): number[] {
  return (sqlite.prepare("SELECT id FROM sync_change_log ORDER BY id").all() as { id: number }[]).map(
    (r) => r.id,
  );
}

/** Append `count` change-log rows and return the ids they were given. */
function seedChanges(sqlite: Database.Database, count: number): number[] {
  const ids: number[] = [];
  sqlite.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      recordChange(sqlite, "note", `note-${i}`, "updated", NOW);
      ids.push(getMaxChangeId(sqlite));
    }
  })();
  return ids;
}

/**
 * Delete a setting so the AFTER DELETE trigger writes a real tombstone, then
 * pin its `deleted_at` so retention windows are deterministic.
 */
function deleteSetting(sqlite: Database.Database, key: string, deletedAt = NOW) {
  sqlite.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)").run(key, "v", NOW);
  sqlite.prepare("DELETE FROM settings WHERE key=?").run(key);
  sqlite
    .prepare("UPDATE sync_tombstones SET deleted_at=? WHERE entity_type='setting' AND entity_id=?")
    .run(deletedAt, key);
  return sqlite
    .prepare(
      "SELECT change_log_id changeLogId,deleted_at deletedAt FROM sync_tombstones WHERE entity_type='setting' AND entity_id=?",
    )
    .get(key) as { changeLogId: number; deletedAt: number };
}

function tombstoneCount(sqlite: Database.Database) {
  return (sqlite.prepare("SELECT COUNT(*) c FROM sync_tombstones").get() as { c: number }).c;
}

function insertCleanupJob(
  sqlite: Database.Database,
  job: { id: string; key: string; attempts?: number; completedAt?: number | null; createdAt?: number },
) {
  sqlite
    .prepare(
      "INSERT INTO storage_cleanup_jobs (id,storage_key,reason,attempts,last_error,created_at,completed_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      job.id,
      job.key,
      "test",
      job.attempts ?? 0,
      null,
      job.createdAt ?? NOW,
      job.completedAt ?? null,
    );
}

// ---------------------------------------------------------------------------
// Migration compatibility
// ---------------------------------------------------------------------------

describe("migration v12 compatibility", () => {
  it("adds the peer-activity and tombstone-boundary columns without dropping any", () => {
    const sqlite = freshDb();
    const cursorCols = (sqlite.prepare("PRAGMA table_info(sync_cursors)").all() as { name: string }[])
      .map((c) => c.name);
    const tombstoneCols = (
      sqlite.prepare("PRAGMA table_info(sync_tombstones)").all() as { name: string }[]
    ).map((c) => c.name);

    expect(cursorCols).toContain("last_active_at");
    expect(tombstoneCols).toContain("change_log_id");
    expect(cursorCols).toEqual(expect.arrayContaining(["peer_id", "last_advance_id", "advanced_at"]));
    expect(tombstoneCols).toEqual(expect.arrayContaining(["entity_type", "entity_id", "deleted_at"]));
  });

  it("treats an upgraded row with no activity timestamp as active at its last advance", () => {
    const sqlite = freshDb();
    advanceCursor(sqlite, "legacy", 4);
    // Exactly what a v11 database looks like before the backfill runs.
    sqlite
      .prepare("UPDATE sync_cursors SET last_active_at=NULL,advanced_at=? WHERE peer_id=?")
      .run(NOW - 10 * DAY, "legacy");

    expect(getCursor(sqlite, "legacy")?.lastActiveAt).toBe(NOW - 10 * DAY);
    // Ten days of silence is well inside a 90-day window: still active.
    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual([]);
    expect(collectSyncMaintenanceStats(sqlite, { now: NOW }).peers.active).toBe(1);
  });

  it("never prunes a legacy tombstone that has no recorded boundary", () => {
    const sqlite = freshDb();
    sqlite
      .prepare(
        "INSERT INTO sync_tombstones (entity_type,entity_id,deleted_at,change_log_id) VALUES ('note','orphan',?,NULL)",
      )
      .run(NOW - 365 * DAY);
    syncTo(sqlite, "peer-a", 999_999);

    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 0 })).toBe(0);
    expect(collectSyncMaintenanceStats(sqlite, { now: NOW }).tombstones.withoutBoundary).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Peer activity and expiry
// ---------------------------------------------------------------------------

describe("peer activity and expiry", () => {
  it("keeps an idle but reachable peer, so it never loses incremental sync", () => {
    const sqlite = freshDb();
    syncTo(sqlite, "desktop", 12, NOW - 200 * DAY);

    // The device is fully caught up, so it never calls /advance — but reading
    // its cursor proves it is alive.
    expect(touchPeerActivity(sqlite, "desktop", NOW - 1 * DAY)).toBe(true);

    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual([]);
    expect(getCursor(sqlite, "desktop")).toMatchObject({ lastAdvanceId: 12 });
  });

  it("expires a silent peer and drops its cursor so it re-baselines from the snapshot", () => {
    const sqlite = freshDb();
    syncTo(sqlite, "abandoned", 7, NOW - 120 * DAY);

    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual(["abandoned"]);
    // A missing cursor is precisely the signal the client uses to switch from
    // /sync/changes to /sync/snapshot — nothing is lost, nothing is merged.
    expect(getCursor(sqlite, "abandoned")).toBeNull();
  });

  it("never invents a cursor for an unknown peer", () => {
    const sqlite = freshDb();

    expect(touchPeerActivity(sqlite, "never-seen", NOW)).toBe(false);
    expect(getCursor(sqlite, "never-seen")).toBeNull();
    expect(listPeerCursors(sqlite)).toEqual([]);
  });

  it("restores incremental sync when an expired peer comes back", () => {
    const sqlite = freshDb();
    seedChanges(sqlite, 5);
    syncTo(sqlite, "returning", 2, NOW - 200 * DAY);
    expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY });
    expect(getCursor(sqlite, "returning")).toBeNull();

    // The client re-baselines from the snapshot, then advances to that head.
    const head = getMaxChangeId(sqlite);
    const cursor = advanceCursor(sqlite, "returning", head);

    expect(cursor.lastAdvanceId).toBe(head);
    expect(cursor.lastActiveAt).toBeGreaterThan(0);
    expect(getCursor(sqlite, "returning")?.lastAdvanceId).toBe(head);
  });
});

// ---------------------------------------------------------------------------
// Change log pruning
// ---------------------------------------------------------------------------

describe("change log pruning", () => {
  it("prunes only what every peer has consumed", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 6);
    syncTo(sqlite, "fast", ids[4]);
    syncTo(sqlite, "slow", ids[1]);

    const removed = pruneChangeLog(sqlite, { now: NOW, maxInactiveMs: 90 * DAY });

    // Everything up to the slow peer's cursor, and nothing beyond it.
    expect(removed).toBe(BASELINE_CHANGE_ROWS + 2);
    expect(changeLogIds(sqlite)).toEqual(ids.slice(2));
  });

  it("prunes nothing while no peer has ever synced", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 4);

    expect(activeSyncBoundary(sqlite)).toBeNull();
    expect(pruneChangeLog(sqlite, { now: NOW })).toBe(0);
    expect(changeLogIds(sqlite)).toEqual(expect.arrayContaining(ids));
  });

  it("keeps the whole log when the only peer is still at zero", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 3);
    syncTo(sqlite, "fresh", 0);

    expect(pruneChangeLog(sqlite, { now: NOW })).toBe(0);
    expect(changeLogIds(sqlite)).toEqual(expect.arrayContaining(ids));
  });

  it("expires a laggard and prunes in one transaction, leaving no resumable gap", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 6);
    syncTo(sqlite, "active", ids[4]);
    syncTo(sqlite, "stale", ids[0], NOW - 200 * DAY);

    const removed = pruneChangeLog(sqlite, { now: NOW, maxInactiveMs: 90 * DAY });

    expect(removed).toBe(BASELINE_CHANGE_ROWS + 5);
    expect(changeLogIds(sqlite)).toEqual(ids.slice(5));
    // The invariant: no surviving cursor may point into the pruned region.
    expect(getCursor(sqlite, "stale")).toBeNull();
    const survivingMin = Math.min(...listPeerCursors(sqlite).map((p) => p.lastAdvanceId));
    expect(survivingMin).toBeGreaterThanOrEqual(changeLogIds(sqlite)[0] - 1);
  });
});

// ---------------------------------------------------------------------------
// Tombstone pruning
// ---------------------------------------------------------------------------

describe("tombstone pruning", () => {
  it("records the change-log position that carries the deletion", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 3);

    const tombstone = deleteSetting(sqlite, "theme");

    // The boundary is the id the deletion's own change-log row will take.
    expect(tombstone.changeLogId).toBe(ids[ids.length - 1] + 1);
    recordChange(sqlite, "setting", "theme", "deleted", NOW);
    expect(getMaxChangeId(sqlite)).toBe(tombstone.changeLogId);
  });

  it("keeps a tombstone until every peer has crossed its boundary", () => {
    const sqlite = freshDb();
    seedChanges(sqlite, 3);
    const tombstone = deleteSetting(sqlite, "theme", NOW - 400 * DAY);
    recordChange(sqlite, "setting", "theme", "deleted", NOW);

    syncTo(sqlite, "fast", tombstone.changeLogId);
    syncTo(sqlite, "slow", tombstone.changeLogId - 1);

    // The slow peer has not seen the deletion yet: dropping the tombstone now
    // would let it resurrect the entity on its next push.
    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 0 })).toBe(0);
    expect(tombstoneCount(sqlite)).toBe(1);
  });

  it("keeps an acknowledged tombstone that is younger than the retention floor", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 5 * DAY);
    syncTo(sqlite, "fast", tombstone.changeLogId + 10);

    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 30 * DAY })).toBe(0);
    expect(tombstoneCount(sqlite)).toBe(1);
  });

  it("prunes once the boundary is acknowledged and the floor has elapsed", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 60 * DAY);
    syncTo(sqlite, "fast", tombstone.changeLogId + 10);

    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 30 * DAY })).toBe(1);
    expect(tombstoneCount(sqlite)).toBe(0);
  });

  it("prunes nothing when no cursor remains, even for an ancient tombstone", () => {
    const sqlite = freshDb();
    deleteSetting(sqlite, "theme", NOW - 900 * DAY);

    // "Nobody is listening" is not evidence that everybody has heard.
    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 0 })).toBe(0);
    expect(tombstoneCount(sqlite)).toBe(1);
  });

  it("unlocks pruning when the last peer is expired, because expiry gates it", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    // The peer never saw the deletion: its cursor sits before the boundary.
    syncTo(sqlite, "stale", tombstone.changeLogId - 1, NOW - 400 * DAY);

    const result = runSyncDataMaintenance(sqlite, {
      now: NOW,
      peerMaxInactiveMs: 90 * DAY,
      tombstoneMinRetentionMs: 30 * DAY,
    });

    expect(result.expiredPeers).toEqual(["stale"]);
    // The gate is what makes this safe. The expired device can no longer pull
    // or push incrementally; when it returns it must rebuild from the
    // snapshot, which simply has no such entity. Nothing can resurrect, so the
    // tombstone has no one left to protect against.
    expect(result.rebaselineRequiredPeers).toBe(1);
    expect(result.removedTombstones).toBe(1);
    expect(tombstoneCount(sqlite)).toBe(0);
    expect(isPeerRebaselineRequired(sqlite, "stale")).toBe(true);
  });

  it("resets the boundary when an entity is deleted, re-created and deleted again", () => {
    const sqlite = freshDb();
    const first = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    seedChanges(sqlite, 5);
    const second = deleteSetting(sqlite, "theme", NOW - 900 * DAY);

    expect(second.changeLogId).toBeGreaterThan(first.changeLogId);
    // A peer that only reached the first deletion must not prune the new one.
    syncTo(sqlite, "slow", first.changeLogId);
    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 0 })).toBe(0);
    expect(tombstoneCount(sqlite)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Re-baseline gate
// ---------------------------------------------------------------------------

describe("re-baseline gate", () => {
  it("remembers an expired peer instead of forgetting it", () => {
    const sqlite = freshDb();
    syncTo(sqlite, "abandoned", 7, NOW - 120 * DAY);

    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual(["abandoned"]);

    // The cursor is dropped so nothing is ever pruned against a stale
    // position, but the peer's identity and its obligation survive: the gate
    // is what the server enforces on every later pull and push.
    expect(getCursor(sqlite, "abandoned")).toBeNull();
    expect(isPeerRebaselineRequired(sqlite, "abandoned")).toBe(true);
    expect(countRebaselineRequired(sqlite)).toBe(1);
    expect(listRebaselineRequiredPeers(sqlite)).toEqual([
      { peerId: "abandoned", reason: "peer-inactive", since: NOW },
    ]);
  });

  it("never gates a peer that is still reachable", () => {
    const sqlite = freshDb();
    syncTo(sqlite, "desktop", 3, NOW - 200 * DAY);
    // Caught up, so it never advances — but it is still talking to us.
    touchPeerActivity(sqlite, "desktop", NOW - 1 * DAY);

    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual([]);
    expect(isPeerRebaselineRequired(sqlite, "desktop")).toBe(false);
    expect(countRebaselineRequired(sqlite)).toBe(0);
  });

  it("clears the gate once the peer confirms its snapshot cursor", () => {
    const sqlite = freshDb();
    seedChanges(sqlite, 5);
    syncTo(sqlite, "returning", 2, NOW - 200 * DAY);
    expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY });
    expect(isPeerRebaselineRequired(sqlite, "returning")).toBe(true);

    // The server must first observe a complete snapshot. Advancing alone may
    // not release the gate, otherwise an old peer could forge the confirmation.
    const head = getMaxChangeId(sqlite);
    expect(canCompletePeerRebaseline(sqlite, "returning", head)).toBe(false);
    markPeerSnapshotCompleted(sqlite, "returning", head);
    expect(canCompletePeerRebaseline(sqlite, "returning", head)).toBe(true);
    const cursor = advanceCursor(sqlite, "returning", head);
    clearPeerRebaseline(sqlite, "returning");

    expect(isPeerRebaselineRequired(sqlite, "returning")).toBe(false);
    expect(countRebaselineRequired(sqlite)).toBe(0);
    expect(cursor.lastAdvanceId).toBe(head);
    expect(getCursor(sqlite, "returning")).toMatchObject({ lastAdvanceId: head });
  });

  it("gates a peer again if it goes silent after re-baselining", () => {
    const sqlite = freshDb();
    syncTo(sqlite, "flaky", 4, NOW - 200 * DAY);
    expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY });
    // Re-baselines, then disappears for another two hundred days.
    syncTo(sqlite, "flaky", 9, NOW - 200 * DAY);
    expect(isPeerRebaselineRequired(sqlite, "flaky")).toBe(false);

    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual(["flaky"]);
    expect(isPeerRebaselineRequired(sqlite, "flaky")).toBe(true);
    expect(countRebaselineRequired(sqlite)).toBe(1);
  });

  it("keeps a tombstone an active peer has not acknowledged, even beside a gated one", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    syncTo(sqlite, "stale", tombstone.changeLogId - 1, NOW - 400 * DAY);
    // Still here, still behind the deletion: it has to receive the tombstone.
    syncTo(sqlite, "live", tombstone.changeLogId - 1, NOW - 1 * DAY);

    const result = runSyncDataMaintenance(sqlite, {
      now: NOW,
      peerMaxInactiveMs: 90 * DAY,
      tombstoneMinRetentionMs: 30 * DAY,
    });

    expect(result.expiredPeers).toEqual(["stale"]);
    expect(result.rebaselineRequiredPeers).toBe(1);
    expect(result.removedTombstones).toBe(0);
    expect(tombstoneCount(sqlite)).toBe(1);
  });

  it("applies the retention floor to gated peers too", () => {
    const sqlite = freshDb();
    deleteSetting(sqlite, "theme", NOW - 5 * DAY);
    syncTo(sqlite, "stale", 1, NOW - 400 * DAY);

    const result = runSyncDataMaintenance(sqlite, {
      now: NOW,
      peerMaxInactiveMs: 90 * DAY,
      tombstoneMinRetentionMs: 30 * DAY,
    });

    // Defence in depth: the gate removes the resurrection risk, the floor
    // still buys time to notice a mistake.
    expect(result.rebaselineRequiredPeers).toBe(1);
    expect(result.removedTombstones).toBe(0);
    expect(tombstoneCount(sqlite)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Attachment cleanup jobs
// ---------------------------------------------------------------------------

describe("storage cleanup job retention", () => {
  it("retires completed jobs past the audit window", () => {
    const sqlite = freshDb();
    insertCleanupJob(sqlite, { id: "j1", key: "attachments/a", completedAt: NOW - 60 * DAY });

    expect(pruneCompletedStorageCleanupJobs(sqlite, { now: NOW, storageJobRetentionMs: 30 * DAY })).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) c FROM storage_cleanup_jobs").get()).toEqual({ c: 0 });
  });

  it("keeps completed jobs inside the audit window", () => {
    const sqlite = freshDb();
    insertCleanupJob(sqlite, { id: "j1", key: "attachments/a", completedAt: NOW - 5 * DAY });

    expect(pruneCompletedStorageCleanupJobs(sqlite, { now: NOW, storageJobRetentionMs: 30 * DAY })).toBe(0);
  });

  it("never removes pending or failing jobs, however old", () => {
    const sqlite = freshDb();
    insertCleanupJob(sqlite, { id: "pending", key: "attachments/p", createdAt: NOW - 900 * DAY });
    insertCleanupJob(sqlite, {
      id: "failing",
      key: "attachments/f",
      attempts: STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS + 2,
      createdAt: NOW - 900 * DAY,
    });

    expect(pruneCompletedStorageCleanupJobs(sqlite, { now: NOW, storageJobRetentionMs: 0 })).toBe(0);
    // Retry semantics are untouched: both rows still match the runner's
    // "completed_at IS NULL" query.
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NULL").get(),
    ).toEqual({ c: 2 });
  });

  it("lets a re-orphaned storage key be enqueued again after its job is retired", () => {
    const sqlite = freshDb();
    insertCleanupJob(sqlite, { id: "j1", key: "attachments/a", completedAt: NOW - 60 * DAY });
    // The unique index would otherwise block the orphan rescan forever.
    pruneCompletedStorageCleanupJobs(sqlite, { now: NOW, storageJobRetentionMs: 30 * DAY });

    expect(() => insertCleanupJob(sqlite, { id: "j2", key: "attachments/a" })).not.toThrow();
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NULL").get(),
    ).toEqual({ c: 1 });
  });
});

// ---------------------------------------------------------------------------
// Full pass and observability
// ---------------------------------------------------------------------------

describe("runSyncDataMaintenance", () => {
  it("expires, prunes and retires in a single atomic pass", () => {
    const sqlite = freshDb();
    // Delete first, so the active peer's cursor ends up past the tombstone's
    // boundary and the tombstone is genuinely acknowledged.
    deleteSetting(sqlite, "removed-setting", NOW - 60 * DAY);
    const ids = seedChanges(sqlite, 8);
    insertCleanupJob(sqlite, { id: "old", key: "attachments/old", completedAt: NOW - 60 * DAY });
    insertCleanupJob(sqlite, { id: "pending", key: "attachments/pending" });

    syncTo(sqlite, "active", ids[ids.length - 1]);
    syncTo(sqlite, "stale", ids[0], NOW - 400 * DAY);

    const result = runSyncDataMaintenance(sqlite, {
      now: NOW,
      peerMaxInactiveMs: 90 * DAY,
      tombstoneMinRetentionMs: 30 * DAY,
      storageJobRetentionMs: 30 * DAY,
    });

    expect(result).toMatchObject({
      expiredPeers: ["stale"],
      removedChangeLogRows: BASELINE_CHANGE_ROWS + 8,
      removedTombstones: 1,
      removedStorageCleanupJobs: 1,
      syncBoundary: ids[ids.length - 1],
    });
    // The still-pending attachment job survives.
    expect(sqlite.prepare("SELECT COUNT(*) c FROM storage_cleanup_jobs").get()).toEqual({ c: 1 });
  });

  it("is idempotent — a second pass changes nothing", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 5);
    syncTo(sqlite, "active", ids[ids.length - 1]);
    const options = { now: NOW, peerMaxInactiveMs: 90 * DAY, tombstoneMinRetentionMs: 0 };

    runSyncDataMaintenance(sqlite, options);
    const second = runSyncDataMaintenance(sqlite, options);

    expect(second).toMatchObject({
      expiredPeers: [],
      removedChangeLogRows: 0,
      removedTombstones: 0,
      removedStorageCleanupJobs: 0,
    });
  });

  it("participates in an outer transaction instead of opening its own", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 4);
    syncTo(sqlite, "active", ids[ids.length - 1]);

    expect(() =>
      sqlite.transaction(() => {
        runSyncDataMaintenance(sqlite, { now: NOW, peerMaxInactiveMs: 90 * DAY });
      })(),
    ).not.toThrow();
    expect(changeLogIds(sqlite)).toEqual([]);
  });
});

describe("collectSyncMaintenanceStats", () => {
  it("reports retention state without mutating anything", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 10);
    syncTo(sqlite, "fast", ids[7]);
    syncTo(sqlite, "slow", ids[2], NOW - 400 * DAY);
    insertCleanupJob(sqlite, { id: "pending", key: "attachments/p" });
    insertCleanupJob(sqlite, {
      id: "failing",
      key: "attachments/f",
      attempts: STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS,
    });

    const stats = collectSyncMaintenanceStats(sqlite, { now: NOW, peerMaxInactiveMs: 90 * DAY });

    expect(stats.changeLog).toMatchObject({
      rows: BASELINE_CHANGE_ROWS + 10,
      minId: 1,
      maxId: ids[9],
      prunableRows: BASELINE_CHANGE_ROWS + 3,
    });
    expect(stats.peers).toMatchObject({ total: 2, active: 1, expired: 1, boundary: ids[2] });
    expect(stats.storageCleanupJobs).toMatchObject({ pending: 2, failing: 1, completed: 0 });
    expect(stats.database.bytes).toBeGreaterThan(0);
    expect(stats.warnings).toContain("storage-cleanup-failing");
    // Read-only: nothing was expired or pruned just by looking.
    expect(changeLogIds(sqlite)).toHaveLength(BASELINE_CHANGE_ROWS + 10);
    expect(listPeerCursors(sqlite)).toHaveLength(2);
  });

  it("warns about an unacknowledged backlog instead of deleting it", () => {
    const sqlite = freshDb();
    seedChanges(sqlite, SYNC_CHANGE_LOG_WARN_ROWS);
    // The peer exists but has barely consumed anything, so the entire backlog
    // is still required for it to catch up.
    syncTo(sqlite, "slow", 1);

    const stats = collectSyncMaintenanceStats(sqlite, { now: NOW });

    expect(stats.warnings).toContain("change-log-backlog");
    expect(stats.warnings).toContain("change-log-blocked-by-idle-peer");
    // Capacity protection reports; it never drops unconsumed history.
    expect(stats.changeLog.rows).toBe(SYNC_CHANGE_LOG_WARN_ROWS + BASELINE_CHANGE_ROWS);
    expect(stats.changeLog.prunableRows).toBe(1);
  });

  it("flags a pending cleanup backlog", () => {
    const sqlite = freshDb();
    sqlite.transaction(() => {
      for (let i = 0; i < STORAGE_CLEANUP_JOB_WARN_PENDING; i += 1)
        insertCleanupJob(sqlite, { id: `job-${i}`, key: `attachments/${i}` });
    })();

    expect(collectSyncMaintenanceStats(sqlite, { now: NOW }).warnings).toContain(
      "storage-cleanup-backlog",
    );
  });

  it("reports a healthy database with no warnings", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 3);
    syncTo(sqlite, "active", ids[ids.length - 1]);

    expect(collectSyncMaintenanceStats(sqlite, { now: NOW }).warnings).toEqual([]);
  });

  it("counts gated peers and reports their tombstones as prunable", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    syncTo(sqlite, "gated", tombstone.changeLogId - 1, NOW - 400 * DAY);
    expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY });

    const stats = collectSyncMaintenanceStats(sqlite, {
      now: NOW,
      peerMaxInactiveMs: 90 * DAY,
      tombstoneMinRetentionMs: 30 * DAY,
    });

    // No cursor row survives, but the peer is not invisible: operators can see
    // that one device owes a snapshot rebuild.
    expect(stats.peers).toMatchObject({ total: 0, active: 0, expired: 0, rebaselineRequired: 1 });
    expect(stats.tombstones).toMatchObject({
      rows: 1,
      prunableRows: 1,
      rebaselineRequiredPeers: 1,
      retainedForRebaseline: 0,
    });
  });

  it("attributes a held-back tombstone to the peer that has not acknowledged it", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    syncTo(sqlite, "live", tombstone.changeLogId - 1, NOW - 1 * DAY);

    const stats = collectSyncMaintenanceStats(sqlite, {
      now: NOW,
      peerMaxInactiveMs: 90 * DAY,
      tombstoneMinRetentionMs: 30 * DAY,
    });

    // Old enough to go, but still needed: this is the number to look at when
    // the tombstone table stops shrinking.
    expect(stats.tombstones).toMatchObject({
      rows: 1,
      prunableRows: 0,
      rebaselineRequiredPeers: 0,
      retainedForRebaseline: 1,
    });
    // Reporting never deletes.
    expect(tombstoneCount(sqlite)).toBe(1);
  });

  it("promises exactly what a maintenance pass would actually delete", () => {
    const sqlite = freshDb();
    const tombstone = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    syncTo(sqlite, "acknowledged", tombstone.changeLogId + 5, NOW - 1 * DAY);
    const options = { now: NOW, peerMaxInactiveMs: 90 * DAY, tombstoneMinRetentionMs: 30 * DAY };

    const promised = collectSyncMaintenanceStats(sqlite, options).tombstones.prunableRows;

    expect(runSyncDataMaintenance(sqlite, options).removedTombstones).toBe(promised);
  });
});

// ---------------------------------------------------------------------------
// Upgrading an existing installation
// ---------------------------------------------------------------------------

/**
 * Roll a fully migrated database back to exactly the v11 shape: no peer
 * activity column, no tombstone boundary, no re-baseline gate, and the
 * boundary-writing delete triggers gone. Re-running `applyMigrations` then
 * exercises the real upgrade path instead of a hand-built approximation.
 */
function downgradeToV11(sqlite: Database.Database) {
  sqlite.exec(`
    DROP TRIGGER IF EXISTS sync_tombstone_placement_delete;
    DROP TRIGGER IF EXISTS sync_tombstone_note_delete;
    DROP TRIGGER IF EXISTS sync_tombstone_relation_delete;
    DROP TRIGGER IF EXISTS sync_tombstone_attachment_delete;
    DROP TRIGGER IF EXISTS sync_tombstone_setting_delete;
    DROP INDEX IF EXISTS sync_cursors_last_active_idx;
    DROP INDEX IF EXISTS sync_tombstones_boundary_idx;
    DROP INDEX IF EXISTS storage_cleanup_jobs_completed_idx;
    DROP INDEX IF EXISTS sync_rebaseline_required_created_idx;
    DROP TABLE IF EXISTS sync_rebaseline_required;
    ALTER TABLE sync_cursors DROP COLUMN last_active_at;
    ALTER TABLE sync_tombstones DROP COLUMN change_log_id;
    DELETE FROM schema_migrations WHERE version >= 12;
  `);
}

describe("upgrading a v11 database", () => {
  it("adds the new sync metadata without losing cursors, tombstones or content", () => {
    const sqlite = freshDb();
    const ids = seedChanges(sqlite, 10);
    downgradeToV11(sqlite);
    // Exactly the rows a v11 installation would be carrying.
    sqlite.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)").run("theme", "dark", NOW);
    sqlite
      .prepare("INSERT INTO sync_cursors (peer_id,last_advance_id,advanced_at) VALUES (?,?,?)")
      .run("legacy-desktop", ids[3], NOW - 10 * DAY);
    sqlite
      .prepare("INSERT INTO sync_tombstones (entity_type,entity_id,deleted_at) VALUES (?,?,?)")
      .run("setting", "removed", NOW - 400 * DAY);
    const notesBefore = (sqlite.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c;

    applyMigrations(sqlite);

    // Business data is untouched.
    expect((sqlite.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c).toBe(notesBefore);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='theme'").get()).toEqual({ value: "dark" });
    expect(changeLogIds(sqlite)).toEqual(expect.arrayContaining(ids));

    // The cursor survives, credited with its last advance, so the upgrade
    // itself can never retroactively expire a device that is still in use.
    expect(getCursor(sqlite, "legacy-desktop")).toMatchObject({
      lastAdvanceId: ids[3],
      advancedAt: NOW - 10 * DAY,
      lastActiveAt: NOW - 10 * DAY,
    });
    expect(expireInactivePeers(sqlite, { now: NOW, maxInactiveMs: 90 * DAY })).toEqual([]);

    // The tombstone survives and is given a deliberately pessimistic boundary
    // at the current head, so it is held until every peer has caught up.
    const tombstone = sqlite
      .prepare(
        "SELECT deleted_at deletedAt,change_log_id changeLogId FROM sync_tombstones WHERE entity_type='setting' AND entity_id='removed'",
      )
      .get() as { deletedAt: number; changeLogId: number };
    expect(tombstone.deletedAt).toBe(NOW - 400 * DAY);
    expect(tombstone.changeLogId).toBeGreaterThan(getMaxChangeId(sqlite));
    expect(pruneSyncTombstones(sqlite, { now: NOW, tombstoneMinRetentionMs: 0 })).toBe(0);

    // And the gate exists, empty: nobody is retroactively told to re-baseline.
    expect(countRebaselineRequired(sqlite)).toBe(0);
  });

  it("re-installs the tombstone boundary triggers", () => {
    const sqlite = freshDb();
    seedChanges(sqlite, 4);
    downgradeToV11(sqlite);

    applyMigrations(sqlite);

    const tombstone = deleteSetting(sqlite, "theme", NOW - 900 * DAY);
    expect(tombstone.changeLogId).toBe(getMaxChangeId(sqlite) + 1);
  });

  it("is idempotent — re-running the upgrade changes nothing", () => {
    const sqlite = freshDb();
    downgradeToV11(sqlite);
    applyMigrations(sqlite);
    syncTo(sqlite, "desktop", 3);

    applyMigrations(sqlite);

    expect(getCursor(sqlite, "desktop")).toMatchObject({ lastAdvanceId: 3 });
    expect(
      sqlite.prepare("SELECT COUNT(*) c FROM schema_migrations").get(),
    ).toEqual({ c: 4 });
  });
});
