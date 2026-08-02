/**
 * Query-plan regression tests.
 *
 * Each test verifies that a key SQL query uses an index (not a full table scan)
 * by running EXPLAIN QUERY PLAN with representative data. This ensures the
 * indexes defined in migrations.ts are actually used by the queries in the
 * domain and server layers.
 */

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import { SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID, SYSTEM_ROOT_PLACEMENT_ID } from "@ygdria/shared";

let sqlite: Database.Database;

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

function seedRepresentativeData(db: Database.Database, count = 500) {
  const t = Date.now();
  const insertNote = db.prepare(
    "INSERT INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,archived_at,is_protected,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertPlacement = db.prepare(
    "INSERT INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  );

  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `note-${i}`;
      const isProtected = i % 20 === 0 ? 1 : 0; // 5% protected
      const isDeleted = i % 10 === 0 ? t - 1000 : null; // 10% deleted
      const isArchived = i % 15 === 0 ? t - 2000 : null; // ~7% archived
      insertNote.run(
        id,
        `Note ${i}`,
        "text",
        Buffer.from(`{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello ${i}"}]}]}`),
        "identity",
        50,
        "abc123",
        `Hello ${i}`,
        "{}",
        i + 1,
        isDeleted,
        isArchived,
        isProtected,
        t - i * 1000,
        t - i * 100,
      );
      // All test placements must have a parent (only SYSTEM_ROOT_PLACEMENT_ID
      // is allowed to have a null parent, per the placements_require_parent
      // trigger).
      insertPlacement.run(
        `placement-${i}`,
        id,
        SYSTEM_ROOT_PLACEMENT_ID,
        i,
        t - i * 1000,
        t - i * 100,
      );
    }
    // System notes (Root, Trash, Calendar) are already installed by applyMigrations.
  })();
}

function explainQueryPlan(db: Database.Database, sql: string, params: unknown[] = []): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(
    (r) => r.detail,
  );
}

function expectUsesIndex(details: string[], indexName: string) {
  const usesIndex = details.some((d) => d.includes(indexName));
  if (!usesIndex) {
    console.warn(`Query plan details:`, details.join("\n"));
  }
  expect(usesIndex, `Expected query plan to use index: ${indexName}`).toBe(true);
}

describe("query plan - notes", () => {
  beforeAll(() => {
    sqlite = createTestDb();
    seedRepresentativeData(sqlite);
  });

  it("recentHistory uses notes_protected_updated_idx", () => {
    // This is the query from NoteService.recentHistory()
    const details = explainQueryPlan(
      sqlite,
      `SELECT id,title,updated_at,deleted_at IS NOT NULL isTrashed,archived_at IS NOT NULL isArchived
       FROM notes
       WHERE id NOT IN (?,?,?) AND is_protected=0 AND (deleted_at IS NOT NULL OR archived_at IS NULL)
       ORDER BY updated_at DESC
       LIMIT ?`,
      [SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID, 200],
    );
    expectUsesIndex(details, "notes_protected_updated_idx");
  });

  it("listArchivedNotes uses notes_protected_archived_idx", () => {
    // This is the query from NoteService.listArchivedNotes()
    const details = explainQueryPlan(
      sqlite,
      `SELECT id,title,archived_at,updated_at
       FROM notes
       WHERE deleted_at IS NULL AND archived_at IS NOT NULL AND is_protected=0
       ORDER BY archived_at DESC`,
    );
    expectUsesIndex(details, "notes_protected_archived_idx");
  });

  it("trash listing uses notes_deleted_at_idx", () => {
    // Trash listing queries filter by deleted_at IS NOT NULL without a
    // primary key constraint, so the planner should use notes_deleted_at_idx.
    const details = explainQueryPlan(
      sqlite,
      `SELECT id,title,deleted_at FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    );
    expectUsesIndex(details, "notes_deleted_at_idx");
  });

  it("attachment by-hash uses attachments_content_hash_idx", () => {
    // This is the query from /api/v1/attachments/by-hash/:hash
    const details = explainQueryPlan(
      sqlite,
      `SELECT id,filename,mime_type,size,storage_key FROM attachments WHERE content_hash=? LIMIT 1`,
      ["sha256:abc"],
    );
    expectUsesIndex(details, "attachments_content_hash_idx");
  });

  it("protected note scan uses is_protected index", () => {
    // This is the query from /api/v1/protected-session/change-password
    const details = explainQueryPlan(
      sqlite,
      `SELECT id FROM notes WHERE is_protected=1`,
    );
    // The new index notes_protected_updated_idx starts with is_protected,
    // so it's usable for this query too.
    const usesProtectedIndex = details.some(
      (d) => d.includes("notes_protected_updated_idx") || d.includes("notes_protected_archived_idx"),
    );
    if (!usesProtectedIndex) {
      console.warn("Protected note scan plan:", details.join("\n"));
    }
    expect(usesProtectedIndex).toBe(true);
  });
});