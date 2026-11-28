/** Replication metadata retention. Incremental history is protected by peer
 * acknowledgements; retired history and deletions require protocol-2 snapshots.
 * Local upload cursors retain pending mutations even after remote peer expiry. */

import type Database from "better-sqlite3";
import {
  STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS,
  STORAGE_CLEANUP_JOB_RETENTION_MS,
  STORAGE_CLEANUP_JOB_WARN_PENDING,
  SYNC_CHANGE_LOG_WARN_ROWS,
  SYNC_PEER_MAX_INACTIVE_MS,
  SYNC_TOMBSTONE_WARN_ROWS,
  type SyncMaintenanceStats,
  type SyncMaintenanceWarning,
} from "@ygdria/shared";
import {
  activeSyncBoundary,
  compactUnobservedHistory,
  countRebaselineRequired,
  expireInactivePeers,
} from "./sync-change-log.js";

// The report shape lives in @ygdria/shared so the HTTP client can describe the
// status endpoint without pulling in SQLite. Re-exported here because this
// module is where it is produced.
export type { SyncMaintenanceStats, SyncMaintenanceWarning };

export type SyncMaintenanceOptions = {
  /** Silence window after which a peer stops holding back pruning. */
  peerMaxInactiveMs?: number;
  /** Legacy compatibility field. Tombstone age is ignored. */
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

/** Remove all compatibility tombstones immediately. Deletion events in the
 * change log remain the durable receipt. */
export function pruneSyncTombstones(
  sqlite: Database.Database,
  _options: SyncMaintenanceOptions = {},
): number {
  // Permanent deletion is represented by sync_change_log. The tombstone table
  // contains no information needed after that row exists and is always removed.
  const removed = sqlite.prepare("DELETE FROM sync_tombstones").run().changes;
  if (removed > 0)
    sqlite
      .prepare(
        "UPDATE sync_metadata_state SET tombstones_pruned=1,generation=generation+1 WHERE id=1",
      )
      .run();
  return removed;
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
    result.removedChangeLogRows += compactUnobservedHistory(sqlite, {
      now: options.now,
      maxInactiveMs: options.peerMaxInactiveMs,
    });
    result.removedStorageCleanupJobs = pruneCompletedStorageCleanupJobs(sqlite, options);
    sqlite
      .prepare(
        "DELETE FROM sync_peer_objects WHERE NOT EXISTS(SELECT 1 FROM notes WHERE id=sync_peer_objects.entity_id)",
      )
      .run();
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

  const ageEligibleTombstones = count(sqlite, "SELECT COUNT(*) c FROM sync_tombstones");
  const tombstonePrunableRows = ageEligibleTombstones;
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
      retainedForRebaseline: 0,
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
      oldestActivityAt: (
        sqlite
          .prepare("SELECT MIN(COALESCE(last_active_at,advanced_at)) oldest FROM sync_cursors")
          .get() as { oldest: number | null }
      ).oldest,
    },
    storageCleanupJobs: {
      pending: count(
        sqlite,
        "SELECT COUNT(*) c FROM storage_cleanup_jobs WHERE completed_at IS NULL",
      ),
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
      tombstoneMinRetentionMs: 0,
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
