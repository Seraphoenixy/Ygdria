import { describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { ConflictError, NoteService } from "./index.js";

describe("NoteService archive", () => {
  it("archives idempotently without changing content or creating a revision", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const note = service.create({ title: "Archive me" });
    const before = db.sqlite
      .prepare("SELECT content_hash contentHash,version FROM notes WHERE id=?")
      .get(note.id) as { contentHash: string; version: number };

    const archived = service.archiveNote(note.id, true);
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(service.archiveNote(note.id, true).archivedAt).toBe(archived.archivedAt);
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM revisions WHERE note_id=?").get(note.id)).toEqual({ count: 0 });
    expect(db.sqlite.prepare("SELECT content_hash contentHash FROM notes WHERE id=?").get(note.id)).toEqual({ contentHash: before.contentHash });
    expect(service.search("Archive")).toEqual([]);
    expect(service.search("Archive", true)).toHaveLength(1);

    expect(service.archiveNote(note.id, false).archivedAt).toBeNull();
    expect(service.archiveNote(note.id, false).archivedAt).toBeNull();
  });

  it("does not archive a deleted note and keeps archive state through deletion", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const note = service.create({ title: "Archived then deleted" });
    service.archiveNote(note.id, true);
    service.remove(note.id);
    expect(() => service.archiveNote(note.id, false)).toThrow(ConflictError);
    service.restore(note.id);
    expect(service.get(note.id)?.archivedAt).toEqual(expect.any(Number));
  });
});
