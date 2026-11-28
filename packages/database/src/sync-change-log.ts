/**
 * Sync change log: records every data mutation so incremental sync peers can
 * retrieve only what changed since their last cursor advance.
 *
 * Usage:
 *   recordChange(sqlite, "note", noteId, "updated");
 *   const changes = getChangesSince(sqlite, cursorId, 200);
 *   const cursor = advanceCursor(sqlite, peerId, maxChangeId);
 */

import type Database from "better-sqlite3";
import { SYNC_PEER_MAX_INACTIVE_MS } from "@ygdria/shared";

export type ChangeKind = "created" | "updated" | "deleted";

export type SyncChange = {
  id: number;
  entityType: string;
  entityId: string;
  changeKind: ChangeKind;
  createdAt: number;
};

/** Record a single data mutation in the change log. */
export function recordChange(
  sqlite: Database.Database,
  entityType: string,
  entityId: string,
  changeKind: ChangeKind,
  createdAt = Date.now(),
): void {
  sqlite
    .prepare(
      "INSERT INTO sync_change_log (entity_type, entity_id, change_kind, created_at) VALUES (?,?,?,?)",
    )
    .run(entityType, entityId, changeKind, createdAt);
  if (changeKind === "deleted") {
    // The change-log row is the deletion receipt. Persistent tombstones were
    // removed by explicit product policy; snapshots use absence as authority.
    sqlite
      .prepare("DELETE FROM sync_tombstones WHERE entity_type=? AND entity_id=?")
      .run(entityType, entityId);
    sqlite
      .prepare(
        "UPDATE sync_metadata_state SET tombstones_pruned=1,generation=generation+1 WHERE id=1",
      )
      .run();
  }
}

/** Record a batch of changes atomically. */
export function recordChanges(
  sqlite: Database.Database,
  changes: Array<{ entityType: string; entityId: string; changeKind: ChangeKind }>,
): void {
  if (changes.length === 0) return;
  const stmt = sqlite.prepare(
    "INSERT INTO sync_change_log (entity_type, entity_id, change_kind, created_at) VALUES (?,?,?,?)",
  );
  const t = Date.now();
  const clearTombstone = sqlite.prepare(
    "DELETE FROM sync_tombstones WHERE entity_type=? AND entity_id=?",
  );
  sqlite.transaction(() => {
    for (const c of changes) {
      stmt.run(c.entityType, c.entityId, c.changeKind, t);
      if (c.changeKind === "deleted") clearTombstone.run(c.entityType, c.entityId);
    }
    if (changes.some((change) => change.changeKind === "deleted"))
      sqlite
        .prepare(
          "UPDATE sync_metadata_state SET tombstones_pruned=1,generation=generation+1 WHERE id=1",
        )
        .run();
  })();
}

/**
 * Return all changes with id > cursorId, up to `limit` rows.
 * Returns an empty array when cursorId is at the latest change.
 */
export function getChangesSince(
  sqlite: Database.Database,
  cursorId: number,
  limit = 200,
): SyncChange[] {
  return sqlite
    .prepare(
      "SELECT id,entity_type entityType,entity_id entityId,change_kind changeKind,created_at createdAt FROM sync_change_log WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(cursorId, limit) as SyncChange[];
}

/** Get the change-log high-water mark, including acknowledged rows since pruned. */
export function getMaxChangeId(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(
      `
      SELECT MAX(
        COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_change_log'), 0),
        COALESCE((SELECT id FROM sync_change_log ORDER BY id DESC LIMIT 1), 0)
      ) maxId
    `,
    )
    .get() as { maxId: number };
  return row.maxId;
}

/** A newly authenticated device can still be carrying a cursor from pruned history. */
export function canResumeChangeLog(sqlite: Database.Database, cursor: number): boolean {
  const head = getMaxChangeId(sqlite);
  const { oldest } = sqlite.prepare("SELECT MIN(id) oldest FROM sync_change_log").get() as {
    oldest: number | null;
  };
  return cursor >= (oldest === null ? head : oldest - 1) && cursor <= head;
}

export function isLocalSyncCursor(peerId: string): boolean {
  return peerId.startsWith("in:") || peerId.startsWith("out:");
}

export type PeerCursor = {
  peerId: string;
  lastAdvanceId: number;
  advancedAt: number;
  /** Last time the peer was seen syncing. Falls back to advancedAt on
   * databases upgraded from before peer-activity tracking existed. */
  lastActiveAt: number;
};

/**
 * Advance a peer's cursor to `toAdvanceId`. Returns the new cursor state.
 * Creates the cursor row if it does not exist.
 *
 * Advancing also marks the peer as active: an idle-but-alive device keeps its
 * cursor, and therefore keeps holding back change-log and tombstone pruning.
 */
export function advanceCursor(
  sqlite: Database.Database,
  peerId: string,
  toAdvanceId: number,
): { peerId: string; lastAdvanceId: number; advancedAt: number; lastActiveAt: number } {
  const t = Date.now();
  if (peerId.startsWith("out:")) {
    sqlite
      .prepare(
        `INSERT INTO sync_peer_objects(peer_id,entity_id)
      SELECT ?,l.entity_id FROM sync_change_log l
      WHERE l.entity_type='note' AND l.id<=? AND EXISTS(SELECT 1 FROM notes WHERE id=l.entity_id)
      ON CONFLICT(peer_id,entity_id) DO UPDATE SET pending_generation=NULL`,
      )
      .run(peerId.slice(4), toAdvanceId);
  }
  sqlite
    .prepare(
      `INSERT INTO sync_cursors (peer_id, last_advance_id, advanced_at, last_active_at,last_progress_at) VALUES (?,?,?,?,?)
       ON CONFLICT(peer_id) DO UPDATE SET
         last_progress_at=CASE WHEN excluded.last_advance_id>sync_cursors.last_advance_id THEN excluded.advanced_at ELSE COALESCE(sync_cursors.last_progress_at,sync_cursors.advanced_at) END,
         last_advance_id=excluded.last_advance_id, advanced_at=excluded.advanced_at, last_active_at=excluded.last_active_at`,
    )
    .run(peerId, toAdvanceId, t, t, t);
  return { peerId, lastAdvanceId: toAdvanceId, advancedAt: t, lastActiveAt: t };
}

/**
 * Record that a peer is still participating in sync without moving its cursor.
 *
 * Reading a cursor, pulling changes, and pushing changes all prove liveness, so
 * a device that is up to date (and therefore never advances) is not mistaken
 * for an abandoned one. Deliberately never creates a row: an unknown peer must
 * still go through the snapshot baseline.
 */
export function touchPeerActivity(
  sqlite: Database.Database,
  peerId: string,
  at = Date.now(),
): boolean {
  return (
    sqlite.prepare("UPDATE sync_cursors SET last_active_at=? WHERE peer_id=?").run(at, peerId)
      .changes > 0
  );
}

/** Get a peer's cursor; returns null if never synced. */
export function getCursor(sqlite: Database.Database, peerId: string): PeerCursor | null {
  const row = sqlite
    .prepare(
      "SELECT peer_id peerId,last_advance_id lastAdvanceId,advanced_at advancedAt,COALESCE(last_active_at,advanced_at) lastActiveAt FROM sync_cursors WHERE peer_id=?",
    )
    .get(peerId) as PeerCursor | undefined;
  return row ?? null;
}

/** All known peer cursors, newest activity first. */
export function listPeerCursors(sqlite: Database.Database): PeerCursor[] {
  return sqlite
    .prepare(
      "SELECT peer_id peerId,last_advance_id lastAdvanceId,advanced_at advancedAt,COALESCE(last_active_at,advanced_at) lastActiveAt FROM sync_cursors ORDER BY COALESCE(last_active_at,advanced_at) DESC",
    )
    .all() as PeerCursor[];
}

export type PeerExpiryOptions = {
  /** Silence window after which a peer stops holding back pruning. */
  maxInactiveMs?: number;
  /** Injectable clock, for tests. */
  now?: number;
};

/**
 * Drop cursors for peers that have been silent longer than `maxInactiveMs`.
 *
 * Removing the row is the point: `getCursor` then reports "never synced", which
 * is the existing signal that makes a client rebuild from `/api/v1/sync/snapshot`
 * instead of resuming from a position whose log entries may already be gone.
 * Expiry and pruning therefore have to happen together — see `pruneChangeLog`.
 *
 * On top of dropping the cursor, each expired peer is recorded in
 * `sync_rebaseline_required` so its identity and the gate are not lost. The
 * peer may no longer resume incrementally; it must re-baseline from the
 * snapshot. Local in:/out: positions survive inactivity: the device needs
 * them to keep its offline edits and resume from its last received update.
 */
export function expireInactivePeers(
  sqlite: Database.Database,
  options: PeerExpiryOptions = {},
): string[] {
  const now = options.now ?? Date.now();
  const maxInactiveMs = options.maxInactiveMs ?? SYNC_PEER_MAX_INACTIVE_MS;
  if (!Number.isFinite(maxInactiveMs) || maxInactiveMs <= 0) return [];
  const cutoff = now - maxInactiveMs;
  const expired = (
    sqlite
      .prepare(
        `SELECT peer_id peerId FROM sync_cursors
        WHERE peer_id NOT LIKE 'in:%' AND peer_id NOT LIKE 'out:%'
          AND (COALESCE(last_active_at,advanced_at) < ? OR
            (last_advance_id < ? AND COALESCE(last_progress_at,advanced_at) < ?))`,
      )
      .all(cutoff, getMaxChangeId(sqlite), cutoff) as Array<{ peerId: string }>
  ).map((row) => row.peerId);
  if (expired.length === 0) return [];
  const remove = sqlite.prepare("DELETE FROM sync_cursors WHERE peer_id=?");
  const gate = sqlite.prepare(
    "INSERT OR IGNORE INTO sync_rebaseline_required (peer_id, reason, created_at) VALUES (?,?,?)",
  );
  for (const peerId of expired) {
    remove.run(peerId);
    gate.run(peerId, "peer-inactive-or-stalled", now);
  }
  return expired;
}

/** Whether a peer is currently gated behind a mandatory snapshot re-baseline. */
export function isPeerRebaselineRequired(sqlite: Database.Database, peerId: string): boolean {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sync_rebaseline_required WHERE peer_id=?").get(peerId),
  );
}

/** Record the head of a fully delivered snapshot. Only this proof may unlock
 * a gated peer; an arbitrary /advance request must never bypass the reset. */
export function markPeerSnapshotCompleted(
  sqlite: Database.Database,
  peerId: string,
  maxChangeId: number,
): void {
  sqlite
    .prepare("UPDATE sync_rebaseline_required SET snapshot_max_change_id=? WHERE peer_id=?")
    .run(maxChangeId, peerId);
}

/** A gated peer may resume only after it has received the complete snapshot
 * whose head it is confirming. */
export function canCompletePeerRebaseline(
  sqlite: Database.Database,
  peerId: string,
  cursor: number,
): boolean {
  return Boolean(
    sqlite
      .prepare(
        "SELECT 1 FROM sync_rebaseline_required WHERE peer_id=? AND snapshot_max_change_id=?",
      )
      .get(peerId, cursor),
  );
}

export function clearPeerRebaseline(sqlite: Database.Database, peerId: string): void {
  sqlite.prepare("DELETE FROM sync_rebaseline_required WHERE peer_id=?").run(peerId);
}

/** All peers currently gated behind a snapshot re-baseline. */
export function listRebaselineRequiredPeers(
  sqlite: Database.Database,
): Array<{ peerId: string; reason: string; since: number }> {
  return sqlite
    .prepare("SELECT peer_id peerId,reason,created_at since FROM sync_rebaseline_required")
    .all() as Array<{ peerId: string; reason: string; since: number }>;
}

/** Count of peers currently gated behind a snapshot re-baseline. */
export function countRebaselineRequired(sqlite: Database.Database): number {
  return (sqlite.prepare("SELECT COUNT(*) c FROM sync_rebaseline_required").get() as { c: number })
    .c;
}

/** Lowest cursor position that still has to be preserved for an active peer,
 * or null when no active peer exists (in which case nothing may be pruned).
 * Inbound cursors (`in:*`) track a remote server's change-log IDs rather than
 * this database's own `sync_change_log`, so they must never drive pruning. */
export function activeSyncBoundary(sqlite: Database.Database): number | null {
  const row = sqlite
    .prepare("SELECT MIN(last_advance_id) minId FROM sync_cursors WHERE peer_id NOT LIKE 'in:%'")
    .get() as { minId: number | null };
  return row.minId ?? null;
}

/**
 * Prune change-log entries that every active peer has already consumed.
 *
 * Expired peers are dropped first, inside the same transaction, so the pruning
 * boundary can never move past a cursor that is still readable: either a peer
 * keeps its cursor and keeps its log entries, or it loses both and re-syncs
 * from the snapshot baseline. There is no window in which a peer can resume
 * incrementally from a position that has been pruned away.
 */
export function pruneChangeLog(sqlite: Database.Database, options: PeerExpiryOptions = {}): number {
  let removed = 0;
  const run = () => {
    expireInactivePeers(sqlite, options);
    const boundary = activeSyncBoundary(sqlite);
    if (boundary !== null && boundary > 0)
      removed = sqlite.prepare("DELETE FROM sync_change_log WHERE id <= ?").run(boundary).changes;
    removed += compactUnobservedHistory(sqlite, options);
  };
  if (sqlite.inTransaction) run();
  else sqlite.transaction(run)();
  return removed;
}

/** With no incremental reader, snapshots replace old history. Local upload
 * positions retain the final pending mutation of each entity, including deletes. */
export function compactUnobservedHistory(
  sqlite: Database.Database,
  options: PeerExpiryOptions = {},
): number {
  const remote = sqlite
    .prepare(
      "SELECT 1 FROM sync_cursors WHERE peer_id NOT LIKE 'in:%' AND peer_id NOT LIKE 'out:%' LIMIT 1",
    )
    .get();
  if (remote) return 0;
  const cutoff = (options.now ?? Date.now()) - (options.maxInactiveMs ?? SYNC_PEER_MAX_INACTIVE_MS);
  const outbound = sqlite
    .prepare("SELECT 1 FROM sync_cursors WHERE peer_id LIKE 'out:%' LIMIT 1")
    .get();
  return sqlite
    .prepare(
      outbound
        ? `DELETE FROM sync_change_log WHERE created_at < ? AND id NOT IN
        (SELECT MAX(id) FROM sync_change_log GROUP BY entity_type,entity_id)`
        : "DELETE FROM sync_change_log WHERE created_at < ?",
    )
    .run(cutoff).changes;
}

/** Return only the latest pending mutation for each entity. The result stays
 * ordered by the surviving change id so advancing through a partial batch
 * cannot skip an unrelated entity or resurrect an older value. */
export function getCoalescedChangesSince(
  sqlite: Database.Database,
  cursorId: number,
  limit = 200,
): SyncChange[] {
  return sqlite
    .prepare(
      `
    SELECT l.id,l.entity_type entityType,l.entity_id entityId,l.change_kind changeKind,l.created_at createdAt
    FROM sync_change_log l
    JOIN (
      SELECT entity_type,entity_id,MAX(id) id
      FROM sync_change_log
      WHERE id > ?
      GROUP BY entity_type,entity_id
      ORDER BY id
      LIMIT ?
    ) latest ON latest.id=l.id
    ORDER BY l.id
  `,
    )
    .all(cursorId, limit) as SyncChange[];
}

export function hasChangesAfter(sqlite: Database.Database, cursorId: number): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sync_change_log WHERE id>? LIMIT 1").get(cursorId));
}
