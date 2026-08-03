/**
 * Versioned schema migration system.
 *
 * Each migration is an immutable, ordered step identified by its version.
 * The `schema_migrations` table tracks which versions have been applied and
 * their checksums. The runner applies pending migrations in order within a
 * single transaction, records the result, and verifies that previously
 * applied migrations have not been tampered with.
 *
 * New migrations MUST be appended to the end of the `MIGRATIONS` array.
 * Never modify an existing migration after it has been released.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { encodeDocumentContent } from "./content-codec.js";
import {
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_ROOT_PLACEMENT_ID,
  SYSTEM_TRASH_NOTE_ID,
  SYSTEM_TRASH_PLACEMENT_ID,
  CALENDAR_NOTE_ID,
  CALENDAR_PLACEMENT_ID,
} from "@ygdria/shared";

const emptyDocument = '{"type":"doc","content":[{"type":"paragraph"}]}';

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

export type Migration = {
  version: number;
  description: string;
  /**
   * Immutable release fingerprint. Do not derive this from Function#toString:
   * bundlers legitimately rewrite function source between development and
   * packaged Electron builds.
   */
  checksum: string;
  up: (sqlite: Database.Database) => void;
};

const STABLE_CHECKSUMS = {
  11: "d516b6e2f7184560",
  12: "3c7a91be40d2f815",
  13: "f0a1b2c3d4e5f607",
  14: "9a8b7c6d5e4f3210",
} as const;

/**
 * The change-log id that the *next* logged mutation will receive.
 *
 * `sync_change_log.id` is AUTOINCREMENT, so the next id is one past the
 * high-water mark recorded in `sqlite_sequence` — which, unlike `MAX(id)`,
 * survives pruning of the log itself. The `MAX(id)` term is kept as a floor so
 * the expression stays correct on databases whose sequence row is missing.
 *
 * A tombstone stamped with this value can only be considered acknowledged once
 * a peer's cursor has reached the position where the deletion would have been
 * recorded, which is what makes tombstone pruning safe rather than time-based.
 */
export const NEXT_CHANGE_LOG_ID_SQL =
  "(SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_change_log'),0),COALESCE((SELECT MAX(id) FROM sync_change_log),0))+1)";

const MIGRATIONS: Migration[] = [
  {
    version: 11,
    description: "Restrict note types to text and code",
    checksum: STABLE_CHECKSUMS[11],
    up(sqlite) {
      // v11 is now the supported baseline; fresh databases are created directly
      // from the current schema instead of replaying retired migrations.
      const hasNotes = Boolean(
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'").get(),
      );
      if (!hasNotes) bootstrapV11(sqlite);
      // The original SQLite CHECK constraint cannot be narrowed in place
      // without rebuilding a table referenced by several foreign keys. These
      // triggers are the authoritative write boundary for both fresh and
      // upgraded databases.
      sqlite.exec(`
        DROP TRIGGER IF EXISTS notes_type_valid_on_insert;
        DROP TRIGGER IF EXISTS notes_type_valid_on_update;
        CREATE TRIGGER notes_type_valid_on_insert
        BEFORE INSERT ON notes
        WHEN NEW.type NOT IN ('text', 'code')
        BEGIN SELECT RAISE(ABORT, 'Invalid note type'); END;
        CREATE TRIGGER notes_type_valid_on_update
        BEFORE UPDATE OF type ON notes
        WHEN NEW.type NOT IN ('text', 'code')
        BEGIN SELECT RAISE(ABORT, 'Invalid note type'); END;
      `);
    },
  },
  // Version 12: make replication metadata prunable without weakening any of
  // the guarantees built on top of it.
  //
  //   * sync_cursors.last_active_at distinguishes a peer that is merely idle
  //     between syncs from one that has genuinely stopped participating. Only
  //     the latter stops holding back pruning, and its cursor is dropped so the
  //     next sync restarts from the snapshot baseline instead of resuming from
  //     a position whose log entries no longer exist.
  //   * sync_tombstones.change_log_id records the change-log position that
  //     carried the deletion. A tombstone becomes prunable only after every
  //     still-active peer has advanced past that boundary, so anti-resurrection
  //     is never traded away for disk space.
  {
    version: 12,
    description: "Track peer activity and tombstone acknowledgement boundaries for safe sync pruning",
    checksum: STABLE_CHECKSUMS[12],
    up(sqlite) {
      const cursorColumns = new Set(
        (sqlite.prepare("PRAGMA table_info(sync_cursors)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!cursorColumns.has("last_active_at")) {
        sqlite.exec("ALTER TABLE sync_cursors ADD COLUMN last_active_at integer");
      }
      // Existing peers are credited with their last successful advance so an
      // upgrade never retroactively expires a device that is still in use.
      sqlite.exec("UPDATE sync_cursors SET last_active_at=advanced_at WHERE last_active_at IS NULL");

      const tombstoneColumns = new Set(
        (sqlite.prepare("PRAGMA table_info(sync_tombstones)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!tombstoneColumns.has("change_log_id")) {
        sqlite.exec("ALTER TABLE sync_tombstones ADD COLUMN change_log_id integer");
      }
      // Prefer the real deletion entry when it is still in the log. Otherwise
      // fall back to the current head, which is deliberately pessimistic: the
      // tombstone then waits for every peer to catch up to "now".
      sqlite.exec(`
        UPDATE sync_tombstones SET change_log_id = COALESCE(
          (SELECT MAX(l.id) FROM sync_change_log l
            WHERE l.entity_type=sync_tombstones.entity_type
              AND l.entity_id=sync_tombstones.entity_id
              AND l.change_kind='deleted'),
          ${NEXT_CHANGE_LOG_ID_SQL}
        ) WHERE change_log_id IS NULL;
        CREATE INDEX IF NOT EXISTS sync_cursors_last_active_idx ON sync_cursors(last_active_at);
        CREATE INDEX IF NOT EXISTS sync_tombstones_boundary_idx ON sync_tombstones(change_log_id,deleted_at);
        CREATE INDEX IF NOT EXISTS storage_cleanup_jobs_completed_idx ON storage_cleanup_jobs(completed_at);
      `);

      installSyncTombstoneBoundaries(sqlite);
    },
  },
  // Version 13: persist the "must re-baseline" state for peers that go silent.
  //
  //   * Peer expiry no longer loses the peer's identity: instead of only
  //     deleting the cursor, the server records the peer in
  //     `sync_rebaseline_required`. The cursor is still dropped so nothing is
  //     pruned on the stale position, but the gate survives and is enforced on
  //     every subsequent incremental pull/push.
  //   * A gated peer may only rebuild from `/api/v1/sync/snapshot`. When it
  //     confirms its cursor via `/api/v1/sync/advance`, the gate row is removed
  //     and a fresh, active cursor is re-established.
  //   * Because a gated peer can never resume incrementally, it cannot
  //     resurrect a permanently deleted entity, so tombstone pruning is safe to
  //     run once every remaining peer is behind the gate.
  {
    version: 13,
    description: "Track peers that must re-baseline from the snapshot after going silent",
    checksum: STABLE_CHECKSUMS[13],
    up(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS sync_rebaseline_required (
          peer_id text primary key,
          reason text not null,
          created_at integer not null
        );
        CREATE INDEX IF NOT EXISTS sync_rebaseline_required_created_idx
          ON sync_rebaseline_required(created_at);
      `);
    },
  },
  // Version 14: a gate is only released after the server itself observed the
  // last page of a snapshot. This prevents a stale client from forging an
  // /advance request and immediately resuming incremental writes.
  {
    version: 14,
    description: "Require a completed snapshot before a gated peer can resume sync",
    checksum: STABLE_CHECKSUMS[14],
    up(sqlite) {
      const columns = new Set(
        (sqlite.prepare("PRAGMA table_info(sync_rebaseline_required)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!columns.has("snapshot_max_change_id"))
        sqlite.exec("ALTER TABLE sync_rebaseline_required ADD COLUMN snapshot_max_change_id integer");
    },
  },
];

/** The supported migration history begins at v11. Older migration records are
 * intentionally ignored because the product no longer supports databases
 * older than that baseline. */

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply all pending migrations. Safe to call on every startup.
 * Idempotent: previously applied migrations are skipped.
 * Throws if a previously applied migration's checksum has changed (tamper detection).
 */
export function applyMigrations(sqlite: Database.Database): void {
  // Ensure the migration tracking table exists first.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer primary key,
      description text not null,
      checksum text not null,
      applied_at integer not null
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS migration_integrity_metadata (
      key text primary key,
      value text not null
    )
  `);
  // Verify already-applied migrations before applying pending work.
  for (const migration of MIGRATIONS) {
    const checksum = migration.checksum;

    const existing = sqlite
      .prepare("SELECT checksum FROM schema_migrations WHERE version=?")
      .get(migration.version) as { checksum: string } | undefined;

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration v${migration.version} ("${migration.description}") checksum mismatch: ` +
          `expected ${checksum}, got ${existing.checksum}. The migration has been modified.`,
        );
      }
      continue; // Already applied and verified.
    }

    // Apply the migration in a transaction so it's atomic.
    sqlite.transaction(() => {
      migration.up(sqlite);
      sqlite
        .prepare("INSERT INTO schema_migrations (version, description, checksum, applied_at) VALUES (?,?,?,?)")
        .run(migration.version, migration.description, checksum, Date.now());
    })();
  }
  sqlite
    .prepare("INSERT INTO migration_integrity_metadata (key,value) VALUES ('checksum_format','stable-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run();
}

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

/** Current schema for a new database. v11 is the oldest supported baseline. */
function bootstrapV11(sqlite: Database.Database) {
  sqlite.pragma("secure_delete=ON");
  sqlite.exec(`
    CREATE TABLE notes (id text primary key, title text not null, type text not null default 'text' check (type in ('text','code')), content_data blob not null, content_codec text not null check (content_codec in ('identity','zstd-v1','ciphertext-v1')), content_size integer not null, content_hash text not null, plain_text text not null, is_protected integer not null default 0, properties_json text not null default '{}', version integer not null default 1, deleted_at integer, archived_at integer, created_at integer not null, updated_at integer not null);
    CREATE TABLE settings (key text primary key, value text not null, updated_at integer not null);
    CREATE TABLE placements (id text primary key, note_id text not null references notes(id) on delete cascade, parent_placement_id text references placements(id) on delete cascade, position integer not null, created_at integer not null, updated_at integer not null, check (parent_placement_id is null or parent_placement_id <> id));
    CREATE TABLE relations (id text primary key, source_note_id text not null references notes(id) on delete cascade, relation_type text not null, target_note_id text not null references notes(id) on delete cascade, created_at integer not null);
    CREATE TABLE revisions (id text primary key, note_id text not null references notes(id) on delete cascade, content_data blob not null, content_codec text not null check (content_codec in ('identity','zstd-v1')), content_hash text not null, created_at integer not null);
    CREATE TABLE attachments (id text primary key, filename text not null, mime_type text not null, size integer not null, storage_key text not null unique, content_hash text not null, created_at integer not null);
    CREATE TABLE storage_cleanup_jobs (id text primary key, storage_key text not null unique, reason text not null, attempts integer not null default 0, last_error text, created_at integer not null, completed_at integer);
    CREATE TABLE placement_deletions (id text primary key, snapshot_json text not null, created_at integer not null, undone_at integer);
    CREATE TABLE sync_cursors (peer_id text primary key, last_advance_id integer not null default 0, advanced_at integer not null, last_active_at integer);
    CREATE TABLE sync_change_log (id integer primary key autoincrement, entity_type text not null, entity_id text not null, change_kind text not null check (change_kind in ('created','updated','deleted')), created_at integer not null);
    CREATE TABLE sync_tombstones (entity_type text not null, entity_id text not null, deleted_at integer not null, change_log_id integer, primary key(entity_type,entity_id));
    CREATE TABLE placement_order_versions (parent_placement_id text primary key references placements(id) on delete cascade, updated_at integer not null);
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, plain_text, properties_json, content='notes', content_rowid='rowid');
    CREATE INDEX placements_parent_idx ON placements(parent_placement_id,position);
    CREATE INDEX placements_note_idx ON placements(note_id);
    CREATE INDEX notes_protected_updated_idx ON notes(is_protected,updated_at DESC);
    CREATE INDEX notes_protected_archived_idx ON notes(is_protected,archived_at);
    CREATE INDEX notes_deleted_at_idx ON notes(deleted_at);
    CREATE INDEX relations_target_idx ON relations(target_note_id);
    CREATE UNIQUE INDEX relations_unique ON relations(source_note_id,relation_type,target_note_id);
    CREATE INDEX revisions_note_idx ON revisions(note_id,created_at);
    CREATE INDEX attachments_content_hash_idx ON attachments(content_hash);
    CREATE INDEX storage_cleanup_jobs_pending_idx ON storage_cleanup_jobs(completed_at,created_at);
    CREATE INDEX storage_cleanup_jobs_completed_idx ON storage_cleanup_jobs(completed_at);
    CREATE INDEX placement_deletions_active_idx ON placement_deletions(undone_at,created_at);
    CREATE INDEX sync_change_log_order_idx ON sync_change_log(id);
    CREATE INDEX sync_change_log_entity_idx ON sync_change_log(entity_type,entity_id);
    CREATE INDEX sync_cursors_last_active_idx ON sync_cursors(last_active_at);
    CREATE INDEX sync_tombstones_boundary_idx ON sync_tombstones(change_log_id,deleted_at);
  `);
  installSystemTree(sqlite);
  installSyncTombstoneBoundaries(sqlite);
  const timestamp = Date.now();
  sqlite.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)").run("content_schema_version", "1", timestamp);
  sqlite.prepare("INSERT INTO sync_change_log (entity_type,entity_id,change_kind,created_at) VALUES ('setting','content_schema_version','updated',?)").run(timestamp);
}

/**
 * Re-create the tombstone-writing triggers so each tombstone also records the
 * change-log position that carries its deletion.
 *
 * v12 replaces the baseline definitions in place, so a freshly created
 * database and an upgraded one converge on the same trigger definitions.
 *
 * The recorded boundary is the id the deletion's own change-log row will take.
 * A peer whose cursor has reached it has necessarily consumed the deletion, so
 * the tombstone is no longer needed to stop that peer from resurrecting the
 * entity. Deleting and re-creating an entity resets the boundary, because the
 * insert trigger clears the tombstone and the next delete writes a fresh one.
 */
function installSyncTombstoneBoundaries(sqlite: Database.Database) {
  const deleteTrigger = (name: string, table: string, entityType: string, idColumn: string) => `
    DROP TRIGGER IF EXISTS ${name};
    CREATE TRIGGER ${name} AFTER DELETE ON ${table} BEGIN
      INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at,change_log_id)
      VALUES ('${entityType}',OLD.${idColumn},CAST(strftime('%s','now') AS INTEGER)*1000,${NEXT_CHANGE_LOG_ID_SQL})
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at,change_log_id=excluded.change_log_id;
    END;
  `;
  sqlite.exec([
    deleteTrigger("sync_tombstone_placement_delete", "placements", "placement", "id"),
    deleteTrigger("sync_tombstone_note_delete", "notes", "note", "id"),
    deleteTrigger("sync_tombstone_relation_delete", "relations", "relation", "id"),
    deleteTrigger("sync_tombstone_attachment_delete", "attachments", "attachment", "id"),
    deleteTrigger("sync_tombstone_setting_delete", "settings", "setting", "key"),
  ].join("\n"));
}

function installSystemTree(sqlite: Database.Database) {
  sqlite.exec(`
    DROP TRIGGER IF EXISTS placements_require_parent_on_insert;
    DROP TRIGGER IF EXISTS placements_require_parent_on_update;
    DROP TRIGGER IF EXISTS placements_root_must_be_root_on_update;
    DROP TRIGGER IF EXISTS placements_prevent_cycle_on_update;
    DROP TRIGGER IF EXISTS placements_system_cannot_be_deleted;
    DROP TRIGGER IF EXISTS placements_system_cannot_be_moved;
    DROP TRIGGER IF EXISTS placements_system_notes_cannot_be_cloned;
  `);
  const t = Date.now();
  const rootContent = emptyDocument;
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      SYSTEM_ROOT_NOTE_ID,
      "Root",
      "text",
      encodeDocumentContent(rootContent).data,
      "identity",
      Buffer.byteLength(rootContent),
      contentHash(rootContent),
      "",
      "{}",
      1,
      null,
      t,
      t,
    );
  sqlite.prepare("UPDATE notes SET deleted_at=NULL WHERE id=?").run(SYSTEM_ROOT_NOTE_ID);
  sqlite.prepare("UPDATE notes SET title=? WHERE id=?").run("Root", SYSTEM_ROOT_NOTE_ID);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(SYSTEM_ROOT_PLACEMENT_ID, SYSTEM_ROOT_NOTE_ID, null, 0, t, t);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      SYSTEM_TRASH_NOTE_ID,
      "回收站",
      "text",
      encodeDocumentContent(rootContent).data,
      "identity",
      Buffer.byteLength(rootContent),
      contentHash(rootContent),
      "",
      "{}",
      1,
      null,
      t,
      t,
    );
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(SYSTEM_TRASH_PLACEMENT_ID, SYSTEM_TRASH_NOTE_ID, SYSTEM_ROOT_PLACEMENT_ID, -1, t, t);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(CALENDAR_NOTE_ID, "日历", "text", encodeDocumentContent(rootContent).data, "identity", Buffer.byteLength(rootContent), contentHash(rootContent), "", "{}", 1, null, t, t);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(CALENDAR_PLACEMENT_ID, CALENDAR_NOTE_ID, SYSTEM_ROOT_PLACEMENT_ID, -2, t, t);
  sqlite
    .prepare("UPDATE placements SET parent_placement_id=NULL WHERE id=? AND parent_placement_id IS NOT NULL")
    .run(SYSTEM_ROOT_PLACEMENT_ID);
  sqlite
    .prepare(
      "UPDATE placements SET parent_placement_id=? WHERE parent_placement_id IS NULL AND id<>?",
    )
    .run(SYSTEM_ROOT_PLACEMENT_ID, SYSTEM_ROOT_PLACEMENT_ID);
  sqlite.exec(`
    DROP TRIGGER IF EXISTS notes_type_valid_on_insert;
    DROP TRIGGER IF EXISTS notes_type_valid_on_update;
    CREATE TRIGGER IF NOT EXISTS notes_type_valid_on_insert
    BEFORE INSERT ON notes
    WHEN NEW.type NOT IN ('text', 'code')
    BEGIN SELECT RAISE(ABORT, 'Invalid note type'); END;
    CREATE TRIGGER IF NOT EXISTS notes_type_valid_on_update
    BEFORE UPDATE OF type ON notes
    WHEN NEW.type NOT IN ('text', 'code')
    BEGIN SELECT RAISE(ABORT, 'Invalid note type'); END;
    CREATE TRIGGER IF NOT EXISTS attachments_storage_key_valid_on_insert
    BEFORE INSERT ON attachments
    WHEN NEW.storage_key = ''
      OR NEW.storage_key NOT LIKE 'attachments/%'
      OR NEW.storage_key LIKE '/%'
      OR NEW.storage_key LIKE '%\\%'
      OR NEW.storage_key LIKE '%..%'
      OR NEW.storage_key GLOB '*[^a-z0-9/_-]*'
    BEGIN SELECT RAISE(ABORT, 'Invalid attachment storage key'); END;
    CREATE TRIGGER IF NOT EXISTS attachments_storage_key_valid_on_update
    BEFORE UPDATE OF storage_key ON attachments
    WHEN NEW.storage_key = ''
      OR NEW.storage_key NOT LIKE 'attachments/%'
      OR NEW.storage_key LIKE '/%'
      OR NEW.storage_key LIKE '%\\%'
      OR NEW.storage_key LIKE '%..%'
      OR NEW.storage_key GLOB '*[^a-z0-9/_-]*'
    BEGIN SELECT RAISE(ABORT, 'Invalid attachment storage key'); END;
    CREATE TRIGGER IF NOT EXISTS placements_require_parent_on_insert
    BEFORE INSERT ON placements
    WHEN NEW.id <> '${SYSTEM_ROOT_PLACEMENT_ID}' AND NEW.parent_placement_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'Only the system root placement may have no parent'); END;
    CREATE TRIGGER IF NOT EXISTS placements_require_parent_on_update
    BEFORE UPDATE OF parent_placement_id ON placements
    WHEN NEW.id <> '${SYSTEM_ROOT_PLACEMENT_ID}' AND NEW.parent_placement_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'Only the system root placement may have no parent'); END;
    CREATE TRIGGER IF NOT EXISTS placements_root_must_be_root_on_update
    BEFORE UPDATE OF parent_placement_id ON placements
    WHEN NEW.id = '${SYSTEM_ROOT_PLACEMENT_ID}' AND NEW.parent_placement_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'The system root placement cannot be moved'); END;
    CREATE TRIGGER IF NOT EXISTS placements_prevent_cycle_on_update
    BEFORE UPDATE OF parent_placement_id ON placements
    WHEN NEW.parent_placement_id IS NOT NULL
    BEGIN
      WITH RECURSIVE ancestors(id) AS (
        SELECT NEW.parent_placement_id
        UNION
        SELECT p.parent_placement_id FROM placements p JOIN ancestors a ON p.id=a.id
        WHERE p.parent_placement_id IS NOT NULL
      )
      SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE id=NEW.id)
        THEN RAISE(ABORT, 'A placement cannot be its own ancestor') END;
    END;
    CREATE TRIGGER IF NOT EXISTS placements_system_cannot_be_deleted
    BEFORE DELETE ON placements
    WHEN OLD.id IN ('${SYSTEM_ROOT_PLACEMENT_ID}', '${SYSTEM_TRASH_PLACEMENT_ID}', '${CALENDAR_PLACEMENT_ID}')
    BEGIN SELECT RAISE(ABORT, 'System placements cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS placements_system_cannot_be_moved
    BEFORE UPDATE OF note_id,parent_placement_id ON placements
    WHEN OLD.id IN ('${SYSTEM_ROOT_PLACEMENT_ID}', '${SYSTEM_TRASH_PLACEMENT_ID}', '${CALENDAR_PLACEMENT_ID}')
    BEGIN SELECT RAISE(ABORT, 'System placements cannot be moved'); END;
    CREATE TRIGGER IF NOT EXISTS placements_system_notes_cannot_be_cloned
    BEFORE INSERT ON placements
    WHEN (NEW.note_id = '${SYSTEM_ROOT_NOTE_ID}' AND NEW.id <> '${SYSTEM_ROOT_PLACEMENT_ID}')
      OR (NEW.note_id = '${SYSTEM_TRASH_NOTE_ID}' AND NEW.id <> '${SYSTEM_TRASH_PLACEMENT_ID}')
      OR (NEW.note_id = '${CALENDAR_NOTE_ID}' AND NEW.id <> '${CALENDAR_PLACEMENT_ID}')
    BEGIN SELECT RAISE(ABORT, 'System notes cannot be cloned'); END;
  `);
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_fts_delete_on_note_delete
    BEFORE DELETE ON notes
    WHEN OLD.is_protected=0 AND OLD.deleted_at IS NULL
    BEGIN
      INSERT INTO notes_fts(notes_fts,rowid,title,plain_text,properties_json)
      VALUES ('delete',OLD.rowid,OLD.title,OLD.plain_text,OLD.properties_json);
    END;
  `);
}

function contentHash(contentJson: string) {
  try {
    return createHash("sha256")
      .update(stableJson(JSON.parse(contentJson)))
      .digest("hex");
  } catch {
    return createHash("sha256").update(contentJson).digest("hex");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
