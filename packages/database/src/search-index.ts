import type Database from "better-sqlite3";

export type SearchIndexDiagnostics = {
  activeNoteCount: number;
  uniqueIndexedNoteCount: number;
  missingIndexCount: number;
  deletedNoteIndexCount: number;
  danglingIndexCount: number;
  duplicateNoteIds: Array<{ noteId: string; count: number }>;
};

/** Returns consistency information for the non-authoritative FTS projection. */
export function inspectSearchIndex(sqlite: Database.Database): SearchIndexDiagnostics {
  const scalar = (sql: string) => (sqlite.prepare(sql).get() as { count: number }).count;
  return {
    activeNoteCount: scalar("SELECT COUNT(*) count FROM notes WHERE deleted_at IS NULL"),
    uniqueIndexedNoteCount: scalar("SELECT COUNT(*) count FROM notes_fts_docsize"),
    missingIndexCount: scalar(`
      SELECT COUNT(*) count FROM notes n
      WHERE n.deleted_at IS NULL AND n.is_protected=0
        AND NOT EXISTS (SELECT 1 FROM notes_fts_docsize f WHERE f.id=n.rowid)
    `),
    deletedNoteIndexCount: scalar(`
      SELECT COUNT(*) count FROM notes_fts_docsize f
      JOIN notes n ON n.rowid=f.id
      WHERE n.deleted_at IS NOT NULL
    `),
    danglingIndexCount: scalar(`
      SELECT COUNT(*) count FROM notes_fts_docsize f
      LEFT JOIN notes n ON n.rowid=f.id
      WHERE n.rowid IS NULL
    `),
    duplicateNoteIds: sqlite
      .prepare("SELECT n.id noteId,COUNT(*) count FROM notes_fts_docsize f JOIN notes n ON n.rowid=f.id GROUP BY f.id HAVING COUNT(*) > 1")
      .all() as Array<{ noteId: string; count: number }>,
  };
}

/** Recreates the whole FTS projection from the authoritative notes table. */
export function rebuildSearchIndex(sqlite: Database.Database) {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    // External-content FTS rows cannot safely be deleted after the source
    // table has already changed (as happens during a sync merge). Recreate
    // the derived index instead of asking FTS to reconstruct old source rows.
    sqlite.exec("DROP TABLE notes_fts");
    sqlite.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(title,plain_text,properties_json, content='notes', content_rowid='rowid')");
    sqlite.exec(`
      INSERT INTO notes_fts(rowid,title,plain_text,properties_json)
      SELECT rowid,title,plain_text,properties_json
      FROM notes
      WHERE deleted_at IS NULL AND is_protected=0
    `);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  return inspectSearchIndex(sqlite);
}
