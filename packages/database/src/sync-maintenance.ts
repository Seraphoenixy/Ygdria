/**
 * Bounded maintenance for replication metadata.
 *
 * Four tables grow with usage and never shrink on their own: `sync_change_log`,
 * `sync_cursors`, `sync_tombstones`, and `storage_cleanup_jobs`. Each one backs
 * a guarantee that must survive the cleanup:
 *
 *   * change log      — offline devices catch up incrementally from it;
 *   * cursors         — a missing cursor is the signal that forces a device
 *                       back onto the full snapshot baseline;
 *   * tombstones      — they stop an out-of-date peer from resurrecting a
 *                       permanently deleted entity;
 *   * cleanup jobs    — they guarantee an attachment file is eventually removed
 *                       from disk, with retries.
 *
 * So nothing here deletes on age alone. Change-log rows and tombstones are only
 * removed once every still-active peer has provably consumed them, and cleanup
 * jobs are only removed once they have completed.
 */

import type Database from "better-sqlite3";
import {
  STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS,
  STORAGE_CLEANUP_JOB_RETENTION_MS,
  STORAGE_CLEANUP_JOB_WARN_PENDING,
  SYNC_CHANGE_LOG_WARN_ROWS,
  SYNC_PEER_MAX_INACTIVE_MS,
  SYNC_TOMBSTONE_MIN_RETENTION_MS,
  SYNC_TOMBSTONE_WARN_ROWS,
  type SyncMaintenanceStats,
  type SyncMaintenanceWarning,
} from "@ygdria/shared";
import { activeSyncBoundary, countRebaselineRequired, expireInactivePeers } from "./sync-change-log.js";

// The report shape lives in @ygdria/shared so the HTTP client can describe the
// status endpoint without pulling in SQLite. Re-exported here because this
// module is where it is produced.
export type { SyncMaintenanceStats, SyncMaintenanceWarning };

export type SyncMaintenanceOptions = {
  /** Silence window after which a peer stops holding back pruning. */
  peerMaxInactiveMs?: number;
  /** Minimum tombstone age, applied *in addition to* the acknowledgement
   *  boundary. Never sufficient on its own. */
  tombstoneMinRetentionMs?: number;
  /** Audit window for completed attachment cleanup jobs. */
  storageJobRetentionMs?: number;
  /** Injectable clock, for tests. */
  now?: number;
};

export type SyncMaintenanceResult = {
  /** Peer ids whose cursor was dropped and who are now gated for re-baseline. */
  expiredPeers: string[];
  /** Peers that remain gated behind a snapshot re-baseline after this pass. */
  rebaselineRequiredPeers: number;
  removedChangeLogRows: number;
  removedTombstones: number;
  removedStorageCleanupJobs: number;
  /** Lowest cursor still held by an active peer, or null when none remain. */
  syncBoundary: number | null;
};

function count(sqlite: Database.Database, sql: string, ...params: unknown[]): number {
  const row = sqlite.prepare(sql).get(...(params as never[])) as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Delete tombstones that every active peer has already replicated.
 *
 * While any active peer still holds an incremental cursor, a tombstone is
 * prunable only when all three hold:
 *   1. it records the change-log position that carried the deletion;
 *   2. every remaining cursor has advanced past that position;
 *   3. it is older than the configured floor (defence in depth).
 *
 * When no active cursor remains there are two very different situations:
 *
 *   * every remaining peer is gated behind a snapshot re-baseline — the server
 *     refuses their incremental pulls and pushes outright, and the snapshot
 *     they must rebuild from is current truth with the deleted entity absent.
 *     Nothing can resurrect, so age-eligible tombstones are prunable;
 *   * no peer is known at all — nothing is pruned. "Nobody is listening" is not
 *     evidence that everybody has heard.
 */
export function pruneSyncTombstones(
  sqlite: Database.Database,
  options: SyncMaintenanceOptions = {},
): number {
  const now = options.now ?? Date.now();
  const minRetentionMs = options.tombstoneMinRetentionMs ?? SYNC_TOMBSTONE_MIN_RETENTION_MS;
  const boundary = activeSyncBoundary(sqlite);
  if (boundary !== null && boundary > 0) {
    // At least one active peer still holds an incremental cursor: a tombstone
    // is prunable only once every such peer has advanced past its boundary AND
    // the retention floor has elapsed.
    return sqlite
      .prepare(
        `DELETE FROM sync_tombstones
          WHERE change_log_id IS NOT NULL
            AND change_log_id <= ?
            AND deleted_at <= ?`,
      )
      .run(boundary, now - minRetentionMs).changes;
  }
  // No active cursor remains. If every remaining peer is gated behind a
  // snapshot re-baseline, pruning is still safe: a gated peer can never resume
  // incrementally, and when it rebuilds from the snapshot it receives current
  // truth (the deleted entity is absent), so it cannot resurrect anything. The
  // retention floor is still applied as defence in depth.
  if (countRebaselineRequired(sqlite) > 0) {
    return sqlite
      .prepare("DELETE FROM sync_tombstones WHERE deleted_at <= ?")
      .run(now - minRetentionMs).changes;
  }
  // "Nobody is listening" is not evidence that everybody has heard, and a
  // returning device may still hold a stale copy — keep the tombstones.
  return 0;
}

/**
 * Delete attachment cleanup jobs that finished longer ago than the audit
 * window. Pending and failing jobs are untouched, so retry behaviour and the
 * orphan rescan keep their existing semantics; dropping the completed rows also
 * lets a storage key that becomes orphaned again be re-enqueued, which the
 * unique index would otherwise block forever.
 */
export function pruneCompletedStorageCleanupJobs(
  sqlite: Database.Database,
  options: SyncMaintenanceOptions = {},
): number {
  const now = options.now ?? Date.now();
  const retentionMs = options.storageJobRetentionMs ?? STORAGE_CLEANUP_JOB_RETENTION_MS;
  return sqlite
    .prepare("DELETE FROM storage_cleanup_jobs WHERE completed_at IS NOT NULL AND completed_at < ?")
    .run(now - retentionMs).changes;
}

/**
 * Run the whole replication-metadata maintenance pass atomically: expire silent
 * peers, prune the change log up to the surviving boundary, prune acknowledged
 * tombstones, and retire audited cleanup jobs.
 */
export function runSyncDataMaintenance(
  sqlite: Database.Database,
  options: SyncMaintenanceOptions = {},
): SyncMaintenanceResult {
  const result: SyncMaintenanceResult = {
    expiredPeers: [],
    rebaselineRequiredPeers: 0,
    removedChangeLogRows: 0,
    removedTombstones: 0,
    removedStorageCleanupJobs: 0,
    syncBoundary: null,
  };
  const run = () => {
    result.expiredPeers = expireInactivePeers(sqlite, {
      maxInactiveMs: options.peerMaxInactiveMs ?? SYNC_PEER_MAX_INACTIVE_MS,
      now: options.now,
    });
    const boundary = activeSyncBoundary(sqlite);
    result.syncBoundary = boundary;
    if (boundary !== null && boundary > 0) {
      result.removedChangeLogRows = sqlite
        .prepare("DELETE FROM sync_change_log WHERE id <= ?")
        .run(boundary).changes;
    }
    result.removedTombstones = pruneSyncTombstones(sqlite, options);
    result.removedStorageCleanupJobs = pruneCompletedStorageCleanupJobs(sqlite, options);
    result.rebaselineRequiredPeers = countRebaselineRequired(sqlite);
  };
  if (sqlite.inTransaction) run();
  else sqlite.transaction(run)();
  return result;
}

/**
 * Snapshot of everything that can grow unbounded, plus the reasons it is
 * currently retained. Purely observational: it never deletes anything, so it is
 * safe to call from a status endpoint.
 */
export function collectSyncMaintenanceStats(
  sqlite: Database.Database,
  options: SyncMaintenanceOptions = {},
): SyncMaintenanceStats {
  const now = options.now ?? Date.now();
  const peerMaxInactiveMs = options.peerMaxInactiveMs ?? SYNC_PEER_MAX_INACTIVE_MS;
  const tombstoneMinRetentionMs =
    options.tombstoneMinRetentionMs ?? SYNC_TOMBSTONE_MIN_RETENTION_MS;
  const storageJobRetentionMs = options.storageJobRetentionMs ?? STORAGE_CLEANUP_JOB_RETENTION_MS;
  const inactiveCutoff = now - peerMaxInactiveMs;
  const boundary = activeSyncBoundary(sqlite);
  const rebaselineRequired = countRebaselineRequired(sqlite);

  const changeLogRange = sqlite
    .prepare(
      "SELECT MIN(id) minId,MAX(id) maxId,MIN(created_at) oldestCreatedAt FROM sync_change_log",
    )
    .get() as { minId: number | null; maxId: number | null; oldestCreatedAt: number | null };

  const pageCount = Number(sqlite.pragma("page_count", { simple: true }) ?? 0);
  const pageSize = Number(sqlite.pragma("page_size", { simple: true }) ?? 0);
  const freelistPages = Number(sqlite.pragma("freelist_count", { simple: true }) ?? 0);

  // Tombstones old enough that only the acknowledgement rule still holds them.
  const ageEligibleTombstones = count(
    sqlite,
    "SELECT COUNT(*) c FROM sync_tombstones WHERE deleted_at <= ?",
    now - tombstoneMinRetentionMs,
  );
  // Mirrors pruneSyncTombstones exactly, so the report can never promise a
  // deletion the maintenance pass would refuse to make.
  const tombstonePrunableRows =
    boundary !== null && boundary > 0
      ? count(
          sqlite,
          "SELECT COUNT(*) c FROM sync_tombstones WHERE change_log_id IS NOT NULL AND change_log_id <= ? AND deleted_at <= ?",
          boundary,
          now - tombstoneMinRetentionMs,
        )
      : rebaselineRequired > 0
        ? ageEligibleTombstones
        : 0;

  const stats: SyncMaintenanceStats = {
    capturedAt: now,
    changeLog: {
      rows: count(sqlite, "SELECT COUNT(*) c FROM sync_change_log"),
      minId: changeLogRange.minId,
      maxId: changeLogRange.maxId,
      oldestCreatedAt: changeLogRange.oldestCreatedAt,
      prunableRows:
        boundary === null || boundary <= 0
          ? 0
          : count(sqlite, "SELECT COUNT(*) c FROM sync_change_log WHERE id <= ?", boundary),
    },
    tombstones: {
      rows: count(sqlite, "SELECT COUNT(*) c FROM sync_tombstones"),
      prunableRows: tombstonePrunableRows,
      withoutBoundary: count(
        sqlite,
        "SELECT COUNT(*) c FROM sync_tombstones WHERE change_log_id IS NULL",
      ),
      rebaselineRequiredPeers: rebaselineRequired,
      // Old enough to go, but still held back because some peer has neither
      // acknowledged the deletion nor been gated into a snapshot re-baseline.
      // This is the number to look at when the tombstone table stops shrinking.
      retainedForRebaseline: ageEligibleTombstones - tombstonePrunableRows,
    },
    peers: {
      total: count(sqlite, "SELECT COUNT(*) c FROM sync_cursors"),
      active: count(
        sqlite,
        "SELECT COUNT(*) c FROM sync_cursors WHERE COALESCE(last_active_at,advanced_at) >= ?",
        inactiveCutoff,
      ),
      expired: count(
        sqlite,
        "SELECT COUNT(*) c FROM sync_cursors WHERE COALESCE(last_active_at,advanced_at) < ?",
        inactiveCutoff,
      ),
      rebaselineRequired,
      boundary,
      oldestActivityAt:
        (
          sqlite
            .prepare("SELECT MIN(COALESCE(last_active_at,advanced_at)) oldest FROM sync_cursors")
            .get() as { oldest: number | null }
        ).oldest,
    },
    storageCleanupJobs: {
      pending: count(sqlite, "SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NULL"),
      failing: count(
        sqlite,
        "SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NULL AND attempts >= ?",
        STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS,
      ),
      completed: count(
        sqlite,
        "SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NOT NULL",
      ),
      prunableCompleted: count(
        sqlite,
        "SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NOT NULL AND completed_at < ?",
        now - storageJobRetentionMs,
      ),
    },
    placementDeletions: { rows: count(sqlite, "SELECT COUNT(*) c FROM placement_deletions") },
    database: {
      pageCount,
      pageSize,
      bytes: pageCount * pageSize,
      freelistPages,
    },
    thresholds: {
      changeLogWarnRows: SYNC_CHANGE_LOG_WARN_ROWS,
      tombstoneWarnRows: SYNC_TOMBSTONE_WARN_ROWS,
      storageCleanupWarnPending: STORAGE_CLEANUP_JOB_WARN_PENDING,
      peerMaxInactiveMs,
      tombstoneMinRetentionMs,
      storageJobRetentionMs,
    },
    warnings: [],
  };

  if (stats.changeLog.rows >= SYNC_CHANGE_LOG_WARN_ROWS) {
    stats.warnings.push("change-log-backlog");
    // Distinguish "a peer is behind" from "the log is simply busy": an
    // unacknowledged backlog must never be deleted, only reported.
    if (stats.changeLog.rows - stats.changeLog.prunableRows >= SYNC_CHANGE_LOG_WARN_ROWS)
      stats.warnings.push("change-log-blocked-by-idle-peer");
  }
  if (stats.tombstones.rows >= SYNC_TOMBSTONE_WARN_ROWS) stats.warnings.push("tombstone-backlog");
  if (stats.storageCleanupJobs.pending >= STORAGE_CLEANUP_JOB_WARN_PENDING)
    stats.warnings.push("storage-cleanup-backlog");
  if (stats.storageCleanupJobs.failing > 0) stats.warnings.push("storage-cleanup-failing");

  return stats;
}
