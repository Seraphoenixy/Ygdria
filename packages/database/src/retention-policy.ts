import type Database from "better-sqlite3";
import { recordChange } from "./sync-change-log.js";

export type RetentionPolicy = {
  revisionLimit: number;
  trashRetentionMs: number;
  attachmentRetentionMs: number;
};

export function readRetentionPolicy(sqlite: Database.Database): RetentionPolicy {
  const row = sqlite
    .prepare(
      "SELECT revision_limit revisionLimit,trash_retention_ms trashRetentionMs,attachment_retention_ms attachmentRetentionMs FROM maintenance_policy WHERE id=1",
    )
    .get() as RetentionPolicy;
  return row;
}

export function writeRetentionPolicy(sqlite: Database.Database, policy: RetentionPolicy): void {
  if (
    !Number.isSafeInteger(policy.revisionLimit) ||
    policy.revisionLimit < -1 ||
    !Number.isSafeInteger(policy.trashRetentionMs) ||
    policy.trashRetentionMs < 0 ||
    !Number.isSafeInteger(policy.attachmentRetentionMs) ||
    policy.attachmentRetentionMs < 0
  )
    throw new RangeError("Invalid retention policy");
  sqlite
    .prepare(
      "UPDATE maintenance_policy SET revision_limit=?,trash_retention_ms=?,attachment_retention_ms=? WHERE id=1",
    )
    .run(policy.revisionLimit, policy.trashRetentionMs, policy.attachmentRetentionMs);
}

/** Runs inside the writer's transaction so every entry point applies the same limit. */
export function pruneNoteRevisions(sqlite: Database.Database, noteId: string): number {
  const { revisionLimit } = readRetentionPolicy(sqlite);
  if (revisionLimit < 0) return 0;
  const rows = sqlite
    .prepare(
      "SELECT id FROM revisions WHERE note_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?",
    )
    .all(noteId, revisionLimit) as Array<{ id: string }>;
  for (const row of rows) {
    sqlite.prepare("DELETE FROM revisions WHERE id=?").run(row.id);
    recordChange(sqlite, "revision", row.id, "deleted");
  }
  return rows.length;
}
