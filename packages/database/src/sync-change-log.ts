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
  sqlite.transaction(() => {
    for (const c of changes) stmt.run(c.entityType, c.entityId, c.changeKind, t);
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

/** Get the current maximum change id (for initial cursor setup). */
export function getMaxChangeId(sqlite: Database.Database): number {
  const row = sqlite
    .prepare("SELECT COALESCE(MAX(id),0) maxId FROM sync_change_log")
    .get() as { maxId: number };
  return row.maxId;
}

/**
 * Advance a peer's cursor to `toAdvanceId`. Returns the new cursor state.
 * Creates the cursor row if it does not exist.
 */
export function advanceCursor(
  sqlite: Database.Database,
  peerId: string,
  toAdvanceId: number,
): { peerId: string; lastAdvanceId: number; advancedAt: number } {
  const t = Date.now();
  sqlite
    .prepare(
      "INSERT INTO sync_cursors (peer_id, last_advance_id, advanced_at) VALUES (?,?,?) ON CONFLICT(peer_id) DO UPDATE SET last_advance_id=excluded.last_advance_id, advanced_at=excluded.advanced_at",
    )
    .run(peerId, toAdvanceId, t);
  return { peerId, lastAdvanceId: toAdvanceId, advancedAt: t };
}

/** Get a peer's cursor; returns null if never synced. */
export function getCursor(
  sqlite: Database.Database,
  peerId: string,
): { peerId: string; lastAdvanceId: number; advancedAt: number } | null {
  const row = sqlite
    .prepare("SELECT peer_id peerId,last_advance_id lastAdvanceId,advanced_at advancedAt FROM sync_cursors WHERE peer_id=?")
    .get(peerId) as { peerId: string; lastAdvanceId: number; advancedAt: number } | undefined;
  return row ?? null;
}

/** Prune change log entries older than the oldest cursor. */
export function pruneChangeLog(sqlite: Database.Database): number {
  const oldest = sqlite
    .prepare("SELECT COALESCE(MIN(last_advance_id),0) minId FROM sync_cursors")
    .get() as { minId: number };
  const result = sqlite
    .prepare("DELETE FROM sync_change_log WHERE id <= ?")
    .run(oldest.minId);
  return result.changes;
}

/** Return only the latest pending mutation for each entity. The result stays
 * ordered by the surviving change id so advancing through a partial batch
 * cannot skip an unrelated entity or resurrect an older value. */
export function getCoalescedChangesSince(
  sqlite: Database.Database,
  cursorId: number,
  limit = 200,
): SyncChange[] {
  return sqlite.prepare(`
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
  `).all(cursorId, limit) as SyncChange[];
}

export function hasChangesAfter(sqlite: Database.Database, cursorId: number): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sync_change_log WHERE id>? LIMIT 1").get(cursorId));
}
