import { describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, decodeStoredContent } from "@ygdria/database";
import { NoteService } from "./index.js";

describe("protected notes", () => {
  it("stores ciphertext, clears plaintext projections, and excludes search and history", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({ title: "Private title", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "private body" }] }] } });
    // Client would encrypt this, but the server just stores the ciphertext as-is
    const ciphertext = "v1.iv.tag.encryptedPayload";
    notes.setProtected(note.id, { protected: true, contentCiphertext: ciphertext });

    const row = db.sqlite.prepare("SELECT title,content_data,content_codec,plain_text,properties_json,is_protected FROM notes WHERE id=?").get(note.id) as any;
    expect(row).toMatchObject({ title: "", content_codec: "ciphertext-v1", plain_text: "", properties_json: "{}", is_protected: 1 });
    expect(decodeStoredContent(row.content_data, row.content_codec)).toBe(ciphertext);
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM notes_fts_docsize WHERE id=(SELECT rowid FROM notes WHERE id=?)").get(note.id)).toEqual({ count: 0 });
    expect(notes.search("private")).toEqual([]);
    expect(notes.recentHistory().some((item: any) => item.id === note.id)).toBe(false);
    expect(notes.revisions(note.id)).toEqual([]);

    // Server returns ciphertext without decrypting
    const protectedNote = notes.get(note.id);
    expect(protectedNote).toMatchObject({
      id: note.id,
      title: "",
      content: null,
      contentCiphertext: ciphertext,
      isProtected: true,
    });
    // Tree includes protected notes (with empty title, frontend decrypts)
    expect(notes.tree().some((item: any) => item.noteId === note.id)).toBe(true);
  });

  it("disabling protection stores plaintext and rebuilds FTS", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({ title: "Secret", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hidden" }] }] } });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });

    // Disable protection with plaintext content
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "now visible" }] }] };
    notes.setProtected(note.id, { protected: false, title: "Revealed", content });

    const unprotected = notes.get(note.id);
    expect(unprotected).toMatchObject({
      id: note.id,
      title: "Revealed",
      isProtected: false,
    });
    expect((unprotected as any).contentCiphertext).toBeUndefined();
    expect(unprotected).toHaveProperty("content");
    // FTS is rebuilt
    expect(notes.search("now visible")).toHaveLength(1);
    expect(notes.search("now visible")[0].title).toBe("Revealed");
  });

  it("finds Chinese text occurring within a continuous Han string", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "日常记录",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "我正在学习新的知识" }] }] },
    });

    expect(notes.search("学习")).toEqual(
      expect.arrayContaining([expect.objectContaining({ noteId: note.id })]),
    );
  });

  it("stores code notes as raw source rather than a rich-text document", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({ title: "Script", type: "code" });

    expect(note.type).toBe("code");
    expect(note.content).toBe("");
    expect(db.sqlite.prepare("SELECT type FROM notes WHERE id=?").get(note.id)).toEqual({ type: "code" });
    notes.update(note.id, { code: "console.log('hello')", expectedVersion: note.version });
    expect(notes.get(note.id)?.content).toBe("console.log('hello')");
    expect(db.sqlite.prepare("SELECT plain_text FROM notes WHERE id=?").get(note.id)).toEqual({ plain_text: "console.log('hello')" });
  });

  it("combines Han substring matching with ranked FTS terms", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const matching = notes.create({ title: "学习 React", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "学习 React hooks" }] }] } });
    notes.create({ title: "学习 Vue", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "学习 Vue" }] }] } });
    notes.create({ title: "React docs", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "React hooks" }] }] } });

    expect(notes.search("学习 React")).toEqual([expect.objectContaining({ noteId: matching.id })]);
    expect(notes.search("学")).toEqual([]);
  });

  it("rebuildSearchIndex skips protected notes (undo path safety)", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({ title: "Will be protected", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "searchable" }] }] } });

    // Initially searchable
    expect(notes.search("searchable")).toHaveLength(1);

    // Protect the note
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });
    expect(notes.search("searchable")).toEqual([]);

    // Simulate an undo path that calls rebuildSearchIndex — should not crash
    // and should not create FTS entries for protected notes
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });

    // Verify no FTS entry was created
    const ftsCount = (db.sqlite.prepare("SELECT COUNT(*) count FROM notes_fts_docsize WHERE id=(SELECT rowid FROM notes WHERE id=?)").get(note.id) as any).count;
    expect(ftsCount).toBe(0);
  });

  it("ETAPI content and putContent reject protected notes", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({ title: "Test", content: { type: "doc", content: [] } });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });

    expect(() => notes.content(note.id, "markdown")).toThrow(/protected/);
    expect(() => notes.content(note.id, "json")).toThrow(/protected/);
    expect(() => notes.putContent(note.id, "# test", "markdown", 2)).toThrow(/protected/);
  });

  it("protected notes cannot be archived", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({ title: "Test", content: { type: "doc", content: [] } });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });

    expect(() => notes.archiveNote(note.id, true)).toThrow(/Protected notes cannot be archived/);
  });

  it("protected notes are excluded from archived list", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);

    // Create and archive a normal note
    const normalNote = notes.create({ title: "Normal", content: { type: "doc", content: [] } });
    notes.archiveNote(normalNote.id, true);

    // Create a protected note
    const protectedNote = notes.create({ title: "Protected", content: { type: "doc", content: [] } });
    notes.setProtected(protectedNote.id, { protected: true, contentCiphertext: "v1.encrypted" });

    const archived = notes.listArchivedNotes();
    expect(archived.some((n: any) => n.id === normalNote.id)).toBe(true);
    expect(archived.some((n: any) => n.id === protectedNote.id)).toBe(false);
  });
});
