/**
 * Background maintenance task runner.
 *
 * Runs maintenance operations (VACUUM, WAL checkpoint, FTS rebuild, etc.)
 * on a dedicated SQLite connection so the main connection is not blocked.
 * Single-task mutual exclusion: a second request while a task is queued or
 * running returns 409. Task status is queryable via getStatus().
 *
 * For in-memory databases (e.g. tests), the runner falls back to executing
 * on the main connection since a second connection to ":memory:" creates a
 * separate, independent database. Execution is still deferred (via
 * setImmediate) so that start() returns immediately and the mutex remains
 * enforceable.
 */

import type { SqliteDatabase, SyncMaintenanceStats } from "@ygdria/database";
import { collectSyncMaintenanceStats, createDatabase, runSyncDataMaintenance } from "@ygdria/database";
import { randomUUID } from "node:crypto";
import {
  PLACEMENT_DELETION_MAX_RECORDS,
  PLACEMENT_DELETION_RETENTION_MS,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_TRASH_NOTE_ID,
  SYSTEM_TRASH_PLACEMENT_ID,
} from "@ygdria/shared";

const MAINTENANCE_COOLDOWN_MS = 15 * 60 * 1000;

export type MaintenanceTaskStatus = "queued" | "running" | "succeeded" | "failed";

export type MaintenanceTask = {
  id: string;
  status: MaintenanceTaskStatus;
  startedAt: number | null;
  completedAt: number | null;
  errorSummary: string | null;
  result: Record<string, unknown> | null;
};

type MaintenanceTaskKind = "maintenance" | "fts-rebuild";
type InternalMaintenanceTask = MaintenanceTask & { kind: MaintenanceTaskKind };

export class MaintenanceRunner {
  private currentTask: InternalMaintenanceTask | null = null;
  private lastFullMaintenanceCompletedAt: number | null = null;
  private dbPath: string;
  private mainSqlite: SqliteDatabase | null = null;
  private lastSyncStats: SyncMaintenanceStats | null = null;

  /**
   * @param dbPath      Filesystem path to the SQLite database file.
   *                    Pass ":memory:" for in-memory databases.
   * @param mainSqlite  Optional main SQLite connection. Required when
   *                    dbPath is ":memory:" so operations run on the
   *                    same in-memory database.
   */
  constructor(dbPath: string, mainSqlite?: SqliteDatabase) {
    this.dbPath = dbPath;
    this.mainSqlite = mainSqlite ?? null;
  }

  /**
   * Returns the current task, or null if no task is queued/running.
   * Once a task finishes, its status is retained until the next task is
   * submitted, so callers can query the outcome.
   */
  getStatus(): MaintenanceTask | null {
    return this.currentTask;
  }

  /** Replication-metadata capacity snapshot taken during the last full run. */
  getLastSyncStats(): SyncMaintenanceStats | null {
    return this.lastSyncStats;
  }

  /**
   * Enqueue a maintenance task. Returns the task ID immediately.
   * Throws an error with statusCode 409 if a task is already queued or running.
   */
  start(
    rebuildFts = false,
  ): { id: string } {
    return this.startTask("maintenance", rebuildFts);
  }

  /** Rebuild only the derived FTS projection. This does not VACUUM and is not
   * subject to the full-maintenance cooldown, but still serializes with every
   * maintenance task because both operations write the same SQLite database. */
  startSearchIndexRebuild(): { id: string } {
    return this.startTask("fts-rebuild", true);
  }

  private startTask(kind: MaintenanceTaskKind, rebuildFts: boolean): { id: string } {
    if (this.currentTask && (this.currentTask.status === "queued" || this.currentTask.status === "running")) {
      throw Object.assign(
        new Error("A maintenance task is already queued or running"),
        { statusCode: 409 },
      );
    }
    if (kind === "maintenance" && this.lastFullMaintenanceCompletedAt &&
        Date.now() - this.lastFullMaintenanceCompletedAt < MAINTENANCE_COOLDOWN_MS) {
      throw Object.assign(
        new Error("Database maintenance was run recently; try again later"),
        { statusCode: 429 },
      );
    }

    const id = randomUUID();
    const task: InternalMaintenanceTask = {
      id,
      kind,
      status: "queued",
      startedAt: null,
      completedAt: null,
      errorSummary: null,
      result: null,
    };
    this.currentTask = task;

    if (this.dbPath === ":memory:" && this.mainSqlite) {
      // In-memory: defer to the next event-loop turn so start() returns
      // immediately with the task in "queued" state, matching the
      // file-based async path and the "returns immediately" contract.
      // A second start() call before this fires sees "queued" -> 409.
      const sqlite = this.mainSqlite;
      setImmediate(() => {
        try {
          this.runTaskOnConnection(id, task, sqlite, rebuildFts);
        } catch (err) {
          task.status = "failed";
          task.completedAt = Date.now();
          task.errorSummary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
      });
    } else {
      // File-based: open a dedicated connection and run asynchronously.
      this.runTaskInBackground(id, task, rebuildFts).catch((err) => {
        console.error("[maintenance] background task crashed:", err);
      });
    }

    return { id };
  }

  private runTaskInBackground(
    id: string,
    task: InternalMaintenanceTask,
    rebuildFts: boolean,
  ): Promise<void> {
    return (async () => {
      const { sqlite: bgSqlite } = createDatabase(this.dbPath);
      try {
        this.runTaskOnConnection(id, task, bgSqlite, rebuildFts);
      } finally {
        bgSqlite.close();
      }
    })();
  }

  private runTaskOnConnection(
    id: string,
    task: InternalMaintenanceTask,
    sqlite: SqliteDatabase,
    rebuildFts: boolean,
  ): void {
    task.status = "running";
    task.startedAt = Date.now();

    try {
      if (task.kind === "fts-rebuild") {
        sqlite.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
        task.status = "succeeded";
        task.completedAt = Date.now();
        task.result = { ftsRebuilt: true };
        task.errorSummary = null;
        return;
      }
      // Step 1: Prune expired placement deletion records on this connection.
      // Do not call NoteService here: it owns the server's main connection.
      const removedUndoSnapshots = prunePlacementDeletions(sqlite);

      // Step 1b: Bound the replication metadata. This expires silent peers,
      // prunes the change log up to the boundary the surviving peers still
      // need, drops tombstones every active peer has acknowledged, and retires
      // completed attachment cleanup jobs past their audit window. Nothing
      // unacknowledged is ever removed — a backlog is reported, not deleted.
      const syncMaintenance = runSyncDataMaintenance(sqlite);
      const syncStats = collectSyncMaintenanceStats(sqlite);
      if (syncMaintenance.expiredPeers.length > 0) {
        console.warn(
          "[maintenance] expired inactive sync peers; they will re-baseline from the snapshot endpoint:",
          syncMaintenance.expiredPeers.join(", "),
        );
      }
      reportSyncCapacity(syncStats);

      // Step 2: Repair ghost records — notes with deleted_at set but no
      // placement in the trash. Add a trash placement so they become visible
      // and can be restored or purged.
      const ghostNoteIds = (sqlite
        .prepare(
          `SELECT n.id FROM notes n
           WHERE n.deleted_at IS NOT NULL
             AND n.id NOT IN (?,?)
             AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.note_id=n.id AND p.parent_placement_id=?)`,
        )
        .all(SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, SYSTEM_TRASH_PLACEMENT_ID) as Array<{ id: string }>
      ).map((row) => row.id);
      for (const noteId of ghostNoteIds) {
        const position = (
          sqlite
            .prepare("SELECT COALESCE(MAX(position),-1)+1 p FROM placements WHERE parent_placement_id=?")
            .get(SYSTEM_TRASH_PLACEMENT_ID) as { p: number }
        ).p;
        sqlite
          .prepare("INSERT OR IGNORE INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)")
          .run(randomUUID(), noteId, SYSTEM_TRASH_PLACEMENT_ID, position, Date.now(), Date.now());
      }
      const repairedGhostCount = ghostNoteIds.length;

      // Step 3: Checkpoint the WAL.
      try { sqlite.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* not all modes support WAL */ }

      // Step 4: Record page counts before VACUUM.
      const beforeBytes =
        Number(sqlite.pragma("page_count", { simple: true })) *
        Number(sqlite.pragma("page_size", { simple: true }));

      // Step 5: VACUUM.
      sqlite.exec("VACUUM");

      // Step 6: Checkpoint after VACUUM.
      try { sqlite.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* not all modes support WAL */ }

      const afterBytes =
        Number(sqlite.pragma("page_count", { simple: true })) *
        Number(sqlite.pragma("page_size", { simple: true }));

      const result: Record<string, unknown> = {
        removedUndoSnapshots,
        repairedGhostCount,
        beforeBytes,
        afterBytes,
        savedBytes: beforeBytes - afterBytes,
        expiredSyncPeers: syncMaintenance.expiredPeers.length,
        removedChangeLogRows: syncMaintenance.removedChangeLogRows,
        removedTombstones: syncMaintenance.removedTombstones,
        removedStorageCleanupJobs: syncMaintenance.removedStorageCleanupJobs,
        syncWarnings: syncStats.warnings,
      };
      this.lastSyncStats = syncStats;

      // Step 7: Optional FTS rebuild.
      if (rebuildFts) {
        sqlite.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
        result.ftsRebuilt = true;
      }

      task.status = "succeeded";
      task.completedAt = Date.now();
      task.result = result;
      task.errorSummary = null;
      this.lastFullMaintenanceCompletedAt = task.completedAt;
    } catch (error) {
      try { sqlite.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
      task.status = "failed";
      task.completedAt = Date.now();
      task.errorSummary =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      task.result = null;
    }
  }
}

/**
 * Surface capacity pressure instead of resolving it destructively. A large
 * change log usually means a peer is far behind, and those rows are exactly the
 * ones that must survive for it to catch up, so the only correct action is to
 * make the situation visible.
 */
function reportSyncCapacity(stats: SyncMaintenanceStats) {
  if (stats.warnings.length === 0) return;
  console.warn("[maintenance] sync data capacity warnings", {
    warnings: stats.warnings,
    changeLogRows: stats.changeLog.rows,
    unacknowledgedChangeLogRows: stats.changeLog.rows - stats.changeLog.prunableRows,
    tombstoneRows: stats.tombstones.rows,
    peers: stats.peers,
    storageCleanupJobs: stats.storageCleanupJobs,
    databaseBytes: stats.database.bytes,
  });
}

function prunePlacementDeletions(sqlite: SqliteDatabase) {
  const cutoff = Date.now() - PLACEMENT_DELETION_RETENTION_MS;
  return sqlite
    .prepare(
      `DELETE FROM placement_deletions
       WHERE created_at < ?
          OR id IN (
            SELECT id FROM placement_deletions
            ORDER BY created_at DESC
            LIMIT -1 OFFSET ?
          )`,
    )
    .run(cutoff, PLACEMENT_DELETION_MAX_RECORDS).changes;
}
