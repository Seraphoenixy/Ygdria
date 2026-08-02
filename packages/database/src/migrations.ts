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
import { decodeStoredContent, encodeDocumentContent, type ContentCodec } from "./content-codec.js";
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
  /** Accept the old, unstable runtime checksum once during format migration. */
  acceptsLegacyRuntimeChecksum?: boolean;
  up: (sqlite: Database.Database) => void;
};

const STABLE_CHECKSUMS = {
  1: "d1cbd04c05a8a7e5",
  2: "e33ad4d4b3c41713",
  3: "eb34418eb718cab6",
  4: "a4b68df86e748133",
  5: "384c8ecec4a91df3",
  6: "486db159f0de18b1",
  7: "62ddd24151f959ed",
  8: "b2d458a4d650ec4f",
  9: "f2d6e98c4c79b0a1",
  10: "d71f6e43b8a20c59",
} as const;

const MIGRATIONS: Migration[] = [
  // Version 1: Baseline schema — all tables, indexes, system tree, and triggers.
  {
    version: 1,
    description: "Baseline schema: tables, indexes, system notes, and triggers",
    checksum: STABLE_CHECKSUMS[1],
    acceptsLegacyRuntimeChecksum: true,
    up(sqlite) {
      sqlite.pragma("secure_delete=ON");
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS notes (id text primary key, title text not null, type text not null default 'text' check (type in ('text','code','file')), content_data blob not null, content_codec text not null check (content_codec in ('identity','zstd-v1','ciphertext-v1')), content_size integer not null, content_hash text not null, plain_text text not null, is_protected integer not null default 0, properties_json text not null default '{}', version integer not null default 1, deleted_at integer, archived_at integer, created_at integer not null, updated_at integer not null);
        CREATE TABLE IF NOT EXISTS settings (key text primary key, value text not null, updated_at integer not null);
        CREATE TABLE IF NOT EXISTS placements (id text primary key, note_id text not null references notes(id) on delete cascade, parent_placement_id text references placements(id) on delete cascade, position integer not null, created_at integer not null, updated_at integer not null, check (parent_placement_id is null or parent_placement_id <> id));
        CREATE TABLE IF NOT EXISTS relations (id text primary key, source_note_id text not null references notes(id) on delete cascade, relation_type text not null, target_note_id text not null references notes(id) on delete cascade, created_at integer not null);
        CREATE TABLE IF NOT EXISTS revisions (id text primary key, note_id text not null references notes(id) on delete cascade, content_data blob not null, content_codec text not null check (content_codec in ('identity','zstd-v1')), content_hash text not null, created_at integer not null);
        CREATE TABLE IF NOT EXISTS attachments (id text primary key, filename text not null, mime_type text not null, size integer not null, storage_key text not null unique, content_hash text not null, created_at integer not null);
        CREATE TABLE IF NOT EXISTS note_attachments (note_id text not null references notes(id) on delete cascade, attachment_id text not null references attachments(id) on delete cascade, created_at integer not null, unique(note_id,attachment_id));
        CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (id text primary key, storage_key text not null unique, reason text not null, attempts integer not null default 0, last_error text, created_at integer not null, completed_at integer);
        CREATE TABLE IF NOT EXISTS placement_deletions (id text primary key, snapshot_json text not null, created_at integer not null, undone_at integer);
        CREATE TABLE IF NOT EXISTS sync_cursors (peer_id text primary key, last_advance_id integer not null default 0, advanced_at integer not null);
        CREATE TABLE IF NOT EXISTS sync_change_log (id integer primary key autoincrement, entity_type text not null, entity_id text not null, change_kind text not null check (change_kind in ('created','updated','deleted')), created_at integer not null);
        CREATE TABLE IF NOT EXISTS sync_tombstones (entity_type text not null, entity_id text not null, deleted_at integer not null, primary key(entity_type,entity_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, plain_text, properties_json, content='notes', content_rowid='rowid');
        DROP INDEX IF EXISTS placements_parent_idx;
        CREATE INDEX placements_parent_idx ON placements(parent_placement_id,position);
        CREATE INDEX IF NOT EXISTS placements_note_idx ON placements(note_id);
        CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_note_id);
        DELETE FROM relations WHERE rowid NOT IN (SELECT MIN(rowid) FROM relations GROUP BY source_note_id,relation_type,target_note_id);
        CREATE UNIQUE INDEX IF NOT EXISTS relations_unique ON relations(source_note_id,relation_type,target_note_id);
        CREATE INDEX IF NOT EXISTS revisions_note_idx ON revisions(note_id,created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS attachments_key_idx ON attachments(storage_key);
        CREATE INDEX IF NOT EXISTS note_attachments_attachment_idx ON note_attachments(attachment_id);
        CREATE UNIQUE INDEX IF NOT EXISTS storage_cleanup_jobs_key_unique ON storage_cleanup_jobs(storage_key);
        CREATE INDEX IF NOT EXISTS storage_cleanup_jobs_pending_idx ON storage_cleanup_jobs(completed_at,created_at);
        CREATE INDEX IF NOT EXISTS placement_deletions_active_idx ON placement_deletions(undone_at,created_at);
        CREATE INDEX IF NOT EXISTS sync_change_log_order_idx ON sync_change_log(id);
        CREATE INDEX IF NOT EXISTS sync_change_log_entity_idx ON sync_change_log(entity_type,entity_id);
      `);
      installSystemTree(sqlite);
      installSyncTombstones(sqlite);
      sqlite
        .prepare("INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,?)")
        .run("content_schema_version", "1", Date.now());
    },
  },
  // Version 2: Sync cursors change log pruning index.
  // (Added as a separate migration to demonstrate the pattern; in practice
  //  this index was already created in version 1.)
  {
    version: 2,
    description: "Add sync_change_log_order_idx (already covered by v1, no-op)",
    checksum: STABLE_CHECKSUMS[2],
    acceptsLegacyRuntimeChecksum: true,
    up(_sqlite) {
      // No-op — the index already exists from version 1.
    },
  },
  // Version 3: Add archived_at column if missing.
  {
    version: 3,
    description: "Add archived_at column to notes (if not present)",
    checksum: STABLE_CHECKSUMS[3],
    acceptsLegacyRuntimeChecksum: true,
    up(sqlite) {
      const columns = new Set(
        (sqlite.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!columns.has("archived_at")) {
        sqlite.exec("ALTER TABLE notes ADD COLUMN archived_at integer");
      }
    },
  },
  // Version 4: Add is_protected column if missing.
  {
    version: 4,
    description: "Add is_protected column to notes (if not present)",
    checksum: STABLE_CHECKSUMS[4],
    acceptsLegacyRuntimeChecksum: true,
    up(sqlite) {
      const columns = new Set(
        (sqlite.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!columns.has("is_protected")) {
        sqlite.exec("ALTER TABLE notes ADD COLUMN is_protected integer not null default 0");
      }
    },
  },
  // Version 5: Query-performance indexes based on EXPLAIN QUERY PLAN analysis.
  //   - notes_protected_updated_idx: serves /api/v1/history (recentHistory) which
  //     filters is_protected=0 and sorts by updated_at DESC.
  //   - notes_protected_archived_idx: serves /api/v1/archived (listArchivedNotes)
  //     which filters is_protected=0, archived_at IS NOT NULL, deleted_at IS NULL
  //     and sorts by archived_at DESC.
  //   - notes_deleted_at_idx: covers trash-centric queries that filter by deleted_at.
  //   - attachments_content_hash_idx: serves /api/v1/attachments/by-hash/:hash
  //     lookups and deduplication in addAttachment.
  {
    version: 5,
    description: "Add query-performance indexes for history, archive, trash, and attachment-by-hash",
    checksum: STABLE_CHECKSUMS[5],
    acceptsLegacyRuntimeChecksum: true,
    up(sqlite) {
      sqlite.exec(`
        CREATE INDEX IF NOT EXISTS notes_protected_updated_idx ON notes(is_protected,updated_at DESC);
        CREATE INDEX IF NOT EXISTS notes_protected_archived_idx ON notes(is_protected,archived_at);
        CREATE INDEX IF NOT EXISTS notes_deleted_at_idx ON notes(deleted_at);
        CREATE INDEX IF NOT EXISTS attachments_content_hash_idx ON attachments(content_hash);
      `);
    },
  },
  // Version 6: Make the pre-existing revision/settings rows visible to the
  // incremental replication protocol, and retain LWW delete tombstones for
  // settings so an older peer cannot recreate a deleted value.
  {
    version: 6,
    description: "Backfill revision and setting changes for incremental sync",
    checksum: STABLE_CHECKSUMS[6],
    acceptsLegacyRuntimeChecksum: true,
    up(sqlite) {
      const timestamp = Date.now();
      sqlite.prepare(
        "INSERT INTO sync_change_log (entity_type,entity_id,change_kind,created_at) SELECT 'revision',id,'created',? FROM revisions WHERE NOT EXISTS(SELECT 1 FROM sync_change_log WHERE entity_type='revision' AND entity_id=revisions.id)",
      ).run(timestamp);
      sqlite.prepare(
        "INSERT INTO sync_change_log (entity_type,entity_id,change_kind,created_at) SELECT 'setting',key,'updated',? FROM settings WHERE NOT EXISTS(SELECT 1 FROM sync_change_log WHERE entity_type='setting' AND entity_id=settings.key)",
      ).run(timestamp);
      sqlite.exec(`
        CREATE TRIGGER IF NOT EXISTS sync_tombstone_setting_delete AFTER DELETE ON settings BEGIN
          INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at) VALUES ('setting',OLD.key,CAST(strftime('%s','now') AS INTEGER)*1000)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_tombstone_setting_insert AFTER INSERT ON settings BEGIN
          DELETE FROM sync_tombstones WHERE entity_type='setting' AND entity_id=NEW.key;
        END;
      `);
    },
  },
  // Version 7: Repair all components that were accidentally added to the
  // mutable v1 baseline, then rebuild its external-content FTS projection.
  {
    version: 7,
    description: "Repair legacy baseline schema and stabilize migration checksums",
    checksum: STABLE_CHECKSUMS[7],
    up(sqlite) {
      sqlite.pragma("secure_delete=ON");
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS sync_cursors (peer_id text primary key, last_advance_id integer not null default 0, advanced_at integer not null);
        CREATE TABLE IF NOT EXISTS sync_change_log (id integer primary key autoincrement, entity_type text not null, entity_id text not null, change_kind text not null check (change_kind in ('created','updated','deleted')), created_at integer not null);
        CREATE TABLE IF NOT EXISTS sync_tombstones (entity_type text not null, entity_id text not null, deleted_at integer not null, primary key(entity_type,entity_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, plain_text, properties_json, content='notes', content_rowid='rowid');
        CREATE INDEX IF NOT EXISTS sync_change_log_order_idx ON sync_change_log(id);
        CREATE INDEX IF NOT EXISTS sync_change_log_entity_idx ON sync_change_log(entity_type,entity_id);
        CREATE INDEX IF NOT EXISTS notes_protected_updated_idx ON notes(is_protected,updated_at DESC);
        CREATE INDEX IF NOT EXISTS notes_protected_archived_idx ON notes(is_protected,archived_at);
        CREATE INDEX IF NOT EXISTS notes_deleted_at_idx ON notes(deleted_at);
        CREATE INDEX IF NOT EXISTS attachments_content_hash_idx ON attachments(content_hash);
      `);
      installSystemTree(sqlite);
      installSyncTombstones(sqlite);
      sqlite.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
    },
  },
  // Version 8: code notes are source files, not rich-text documents. Convert
  // the short-lived JSON codeBlock representation introduced before this
  // distinction existed. The storage codec may still compress the source; it
  // is the decoded content, rather than its transport encoding, that is raw.
  {
    version: 8,
    description: "Store code note bodies as raw source instead of TipTap JSON",
    checksum: STABLE_CHECKSUMS[8],
    up(sqlite) {
      const rows = sqlite.prepare("SELECT id,content_data contentData,content_codec contentCodec FROM notes WHERE type='code' AND is_protected=0").all() as Array<{ id: string; contentData: Buffer; contentCodec: ContentCodec }>;
      const update = sqlite.prepare("UPDATE notes SET content_data=?,content_codec=?,content_size=?,content_hash=?,plain_text=? WHERE id=?");
      for (const row of rows) {
        const legacy = decodeStoredContent(row.contentData, row.contentCodec);
        const source = rawCodeFromLegacyDocument(legacy);
        if (source === null) continue;
        const stored = encodeDocumentContent(source);
        update.run(stored.data, stored.codec, stored.size, contentHash(source), source, row.id);
      }
      sqlite.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
    },
  },
  // Version 9: attachment ownership is derived exclusively from rich-text
  // content. The old join table could outlive a deleted image node and was
  // therefore an invalid source of truth.
  {
    version: 9,
    description: "Remove note_attachments; attachment references live in note content",
    checksum: STABLE_CHECKSUMS[9],
    up(sqlite) {
      sqlite.exec(`
        DROP TRIGGER IF EXISTS sync_tombstone_note_attachment_delete;
        DROP TRIGGER IF EXISTS sync_tombstone_note_attachment_insert;
        DROP INDEX IF EXISTS note_attachments_attachment_idx;
        DROP INDEX IF EXISTS note_attachments_unique;
        DROP TABLE IF EXISTS note_attachments;
        DELETE FROM sync_change_log WHERE entity_type='note_attachment';
        DELETE FROM sync_tombstones WHERE entity_type='note_attachment';
      `);
    },
  },
  {
    version: 10,
    description: "Track atomic sibling-order versions for placement sync",
    checksum: STABLE_CHECKSUMS[10],
    up(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS placement_order_versions (
          parent_placement_id text primary key references placements(id) on delete cascade,
          updated_at integer not null
        );
      `);
    },
  },
];

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
  const hasStableChecksumFormat = Boolean(
    sqlite.prepare("SELECT 1 FROM migration_integrity_metadata WHERE key='checksum_format' AND value='stable-v1'").get(),
  );

  // Verify already-applied migrations before applying pending work.
  for (const migration of MIGRATIONS) {
    const checksum = migration.checksum;

    const existing = sqlite
      .prepare("SELECT checksum FROM schema_migrations WHERE version=?")
      .get(migration.version) as { checksum: string } | undefined;

    if (existing) {
      if (existing.checksum !== checksum) {
        // Previous releases derived this value from Function#toString(). That
        // changes after bundling, so an old development build and an Electron
        // package can disagree without any schema tampering. Accept this only
        // while upgrading a database that has no stable-format marker yet.
        if (!hasStableChecksumFormat && migration.acceptsLegacyRuntimeChecksum && isLegacyRuntimeChecksum(existing.checksum)) {
          sqlite.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?").run(checksum, migration.version);
          continue;
        }
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
// Checksum computation
// ---------------------------------------------------------------------------

function isLegacyRuntimeChecksum(value: string) {
  // Legacy checksums were truncated SHA-256 output. The marker guarantees that
  // this broad compatibility rule can only run once for pre-stable databases.
  return /^[a-f0-9]{16}$/.test(value) && !Object.values(STABLE_CHECKSUMS).includes(value as never);
}

// ---------------------------------------------------------------------------
// Migration helpers (extracted from the original ensureSystemTree and
// ensureSyncTombstones)
// ---------------------------------------------------------------------------

function installSyncTombstones(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_placement_delete AFTER DELETE ON placements BEGIN
      INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at) VALUES ('placement',OLD.id,CAST(strftime('%s','now') AS INTEGER)*1000)
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_placement_insert AFTER INSERT ON placements BEGIN
      DELETE FROM sync_tombstones WHERE entity_type='placement' AND entity_id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_note_delete AFTER DELETE ON notes BEGIN
      INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at) VALUES ('note',OLD.id,CAST(strftime('%s','now') AS INTEGER)*1000)
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_note_insert AFTER INSERT ON notes BEGIN
      DELETE FROM sync_tombstones WHERE entity_type='note' AND entity_id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_relation_delete AFTER DELETE ON relations BEGIN
      INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at) VALUES ('relation',OLD.id,CAST(strftime('%s','now') AS INTEGER)*1000)
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_relation_insert AFTER INSERT ON relations BEGIN
      DELETE FROM sync_tombstones WHERE entity_type='relation' AND entity_id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_attachment_delete AFTER DELETE ON attachments BEGIN
      INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at) VALUES ('attachment',OLD.id,CAST(strftime('%s','now') AS INTEGER)*1000)
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at;
    END;
    CREATE TRIGGER IF NOT EXISTS sync_tombstone_attachment_insert AFTER INSERT ON attachments BEGIN
      DELETE FROM sync_tombstones WHERE entity_type='attachment' AND entity_id=NEW.id;
    END;
  `);
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
    WHEN NEW.type NOT IN ('text', 'code', 'file')
    BEGIN SELECT RAISE(ABORT, 'Invalid note type'); END;
    CREATE TRIGGER IF NOT EXISTS notes_type_valid_on_update
    BEFORE UPDATE OF type ON notes
    WHEN NEW.type NOT IN ('text', 'code', 'file')
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

/** Return source only for the legacy TipTap code-block document shape. */
function rawCodeFromLegacyDocument(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { type?: string; content?: unknown[] };
    if (parsed.type !== "doc" || !Array.isArray(parsed.content) || parsed.content.length !== 1) return null;
    const block = parsed.content[0] as { type?: string; content?: Array<{ type?: string; text?: string }> };
    if (block?.type !== "codeBlock") return null;
    return (block.content ?? []).filter((node) => node.type === "text").map((node) => node.text ?? "").join("");
  } catch {
    return null;
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
