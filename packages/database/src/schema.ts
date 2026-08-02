import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
};

/**
 * Aggregate root: identity, authoritative content and flexible note properties.
 * `updatedAt` changes only with note content or note metadata, never with tree/index maintenance.
 */
export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type", { enum: ["text", "code", "file"] })
    .notNull()
    .default("text"),
  contentData: blob("content_data", { mode: "buffer" }).notNull(),
  contentCodec: text("content_codec", { enum: ["identity", "zstd-v1", "ciphertext-v1"] }).notNull(),
  contentSize: integer("content_size").notNull(),
  contentHash: text("content_hash").notNull(),
  plainText: text("plain_text").notNull(),
  /** When enabled, content_data contains an authenticated encrypted payload. */
  isProtected: integer("is_protected", { mode: "boolean" }).notNull().default(false),
  propertiesJson: text("properties_json").notNull().default("{}"),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  ...timestamps,
});

/** Knowledge-base-wide configuration, including the active content JSON schema version. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** A note's position in the tree; only the fixed system root has no parent. */
export const placements = sqliteTable(
  "placements",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    // SQLite triggers enforce non-null parents for every placement except the system root.
    // Self-reference: drizzle-orm 0.44 + TS strict cannot infer the table's
    // own type while the initializer is still being evaluated, so a return
    // type annotation is required. `typeof placements.id` would recurse
    // (TS2577); the only sound escape is an explicit `any` return type here.
    parentPlacementId: text("parent_placement_id").references((): any => placements.id, {
      onDelete: "cascade",
    }),
    position: integer("position").notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "placements_parent_not_self",
      sql`${table.parentPlacementId} is null or ${table.parentPlacementId} <> ${table.id}`,
    ),
    index("placements_parent_idx").on(table.parentPlacementId, table.position),
    index("placements_note_idx").on(table.noteId),
  ],
);

/** Normalized relation edges are retained for reverse lookup and real foreign keys. */
export const relations = sqliteTable(
  "relations",
  {
    id: text("id").primaryKey(),
    sourceNoteId: text("source_note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    targetNoteId: text("target_note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("relations_target_idx").on(table.targetNoteId),
    uniqueIndex("relations_unique").on(table.sourceNoteId, table.relationType, table.targetNoteId),
  ],
);

export const revisions = sqliteTable("revisions", {
  id: text("id").primaryKey(),
  noteId: text("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  contentData: blob("content_data", { mode: "buffer" }).notNull(),
  contentCodec: text("content_codec", { enum: ["identity", "zstd-v1"] }).notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    storageKey: text("storage_key").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("attachments_key_idx").on(table.storageKey)],
);

/** Durable compensation jobs for files whose metadata is no longer retained. */
export const storageCleanupJobs = sqliteTable(
  "storage_cleanup_jobs",
  {
    id: text("id").primaryKey(),
    storageKey: text("storage_key").notNull(),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("storage_cleanup_jobs_key_unique").on(table.storageKey),
    index("storage_cleanup_jobs_pending_idx").on(table.completedAt, table.createdAt),
  ],
);

/**
 * Sync cursor for incremental replication. Each peer tracks its own cursor;
 * the server returns only changes since the cursor's last_advance_id.
 * A null cursor means "no prior sync" — the client should request a full
 * snapshot as a baseline.
 */
export const syncCursors = sqliteTable("sync_cursors", {
  peerId: text("peer_id").primaryKey(),
  lastAdvanceId: integer("last_advance_id").notNull().default(0),
  advancedAt: integer("advanced_at", { mode: "timestamp_ms" }).notNull(),
});

/** Ordered change log for incremental sync. Each mutation writes one row. */
export const syncChangeLog = sqliteTable(
  "sync_change_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    changeKind: text("change_kind", { enum: ["created", "updated", "deleted"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("sync_change_log_order_idx").on(table.id),
    index("sync_change_log_entity_idx").on(table.entityType, table.entityId),
  ],
);

/** Short-lived snapshots used to undo a placement-subtree deletion. */
export const placementDeletions = sqliteTable(
  "placement_deletions",
  {
    id: text("id").primaryKey(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("placement_deletions_active_idx").on(table.undoneAt, table.createdAt)],
);
