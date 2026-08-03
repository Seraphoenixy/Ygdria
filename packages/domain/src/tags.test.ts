import { describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, decodeStoredContent } from "@ygdria/database";
import { NoteService } from "./index.js";

describe("tags", () => {
  it("creates a note with tags", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Tagged note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
      tags: ["work", "project"],
    });
    expect(note.tags).toEqual(["work", "project"]);
    const row = db.sqlite.prepare("SELECT properties_json FROM notes WHERE id=?").get(note.id) as any;
    expect(JSON.parse(row.properties_json)).toEqual({ tags: ["work", "project"] });
  });

  it("creates a code note with tags and codeLanguage", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Code note",
      type: "code",
      tags: ["dev"],
    });
    expect(note.tags).toEqual(["dev"]);
    expect(note.codeLanguage).toBe("plaintext");
    const row = db.sqlite.prepare("SELECT properties_json FROM notes WHERE id=?").get(note.id) as any;
    const parsed = JSON.parse(row.properties_json);
    expect(parsed.tags).toEqual(["dev"]);
    expect(parsed.codeLanguage).toBe("plaintext");
  });

  it("updates tags on an existing note", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
    });
    const updated = notes.update(note.id, { tags: ["work"], expectedVersion: note.version });
    expect(updated.tags).toEqual(["work"]);
  });

  it("preserves existing tags when updating content without tags", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      tags: ["work"],
    });
    const updated = notes.update(note.id, {
      title: "New title",
      expectedVersion: note.version,
    });
    expect(updated.tags).toEqual(["work"]);
  });

  it("clears tags when updating with empty array", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      tags: ["work"],
    });
    const updated = notes.update(note.id, { tags: [], expectedVersion: note.version });
    expect(updated.tags).toEqual([]);
  });

  it("preserves tags when updating codeLanguage", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Code",
      type: "code",
      tags: ["dev"],
    });
    const updated = notes.update(note.id, {
      codeLanguage: "typescript",
      expectedVersion: note.version,
    });
    expect(updated.tags).toEqual(["dev"]);
    expect(updated.codeLanguage).toBe("typescript");
  });

  it("preserves codeLanguage when updating tags", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Code",
      type: "code",
      code: "console.log('x')",
    });
    const withLanguage = notes.update(note.id, {
      codeLanguage: "javascript",
      expectedVersion: note.version,
    });
    const withTags = notes.update(note.id, {
      tags: ["work"],
      expectedVersion: withLanguage.version,
    });
    expect(withTags.codeLanguage).toBe("javascript");
    expect(withTags.tags).toEqual(["work"]);
  });

  it("preserves tags when updating code content", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Code",
      type: "code",
      code: "old",
      tags: ["dev"],
    });
    const updated = notes.update(note.id, {
      code: "new code",
      expectedVersion: note.version,
    });
    expect(updated.tags).toEqual(["dev"]);
    expect(updated.content).toBe("new code");
  });

  it("normalizes tags: trims, deduplicates, enforces limits", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      tags: ["  work  ", "work", "fun"],
    });
    expect(note.tags).toEqual(["work", "fun"]);
  });

  it("protects a note hiding tags in DB", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Secret",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] },
      tags: ["private"],
    });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });
    const row = db.sqlite.prepare("SELECT properties_json,is_protected FROM notes WHERE id=?").get(note.id) as any;
    expect(row.properties_json).toBe("{}");
    expect(row.is_protected).toBe(1);
  });

  it("unprotects a note restoring tags from encrypted payload", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Secret",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] },
      tags: ["private"],
    });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "now visible" }] }] };
    const unprotected = notes.setProtected(note.id, {
      protected: false,
      title: "Revealed",
      content,
      propertiesJson: '{"tags":["restored"]}',
    });
    expect(unprotected.tags).toEqual(["restored"]);
    expect(unprotected.isProtected).toBe(false);
  });

  it("searchByTag returns notes with exact tag match", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    notes.create({
      title: "Work note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "work content" }] }] },
      tags: ["work", "project"],
    });
    notes.create({
      title: "Fun note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "fun content" }] }] },
      tags: ["fun"],
    });
    const results = notes.searchByTag("work");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Work note");
    expect(results[0].tags).toContain("work");
  });

  it("searchByTag excludes deleted notes", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Work",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "test" }] }] },
      tags: ["work"],
    });
    notes.remove(note.id);
    expect(notes.searchByTag("work")).toEqual([]);
  });

  it("searchByTag excludes archived notes", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Work",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "test" }] }] },
      tags: ["work"],
    });
    notes.archiveNote(note.id, true);
    expect(notes.searchByTag("work")).toEqual([]);
  });

  it("searchByTag excludes protected notes", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Secret",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] },
      tags: ["private"],
    });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });
    expect(notes.searchByTag("private")).toEqual([]);
  });

  it("tagStats aggregates tag usage counts", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    notes.create({
      title: "A",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
      tags: ["work", "fun"],
    });
    notes.create({
      title: "B",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
      tags: ["work"],
    });
    const stats = notes.tagStats();
    expect(stats).toHaveLength(2);
    const workStat = stats.find((s) => s.tag === "work");
    expect(workStat?.count).toBe(2);
    const funStat = stats.find((s) => s.tag === "fun");
    expect(funStat?.count).toBe(1);
  });

  it("tagStats excludes deleted notes", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "A",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
      tags: ["work"],
    });
    notes.remove(note.id);
    expect(notes.tagStats()).toEqual([]);
  });

  it("search returns tags in results", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    notes.create({
      title: "Test note",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "searchable content" }] }] },
      tags: ["work"],
    });
    const results = notes.search("searchable");
    expect(results).toHaveLength(1);
    expect(results[0].tags).toEqual(["work"]);
  });

  it("get returns tags for non-protected note", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Test",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      tags: ["work"],
    });
    const fetched = notes.get(note.id);
    expect(fetched?.tags).toEqual(["work"]);
  });

  it("get returns no tags for protected note", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const notes = new NoteService(db);
    const note = notes.create({
      title: "Secret",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] },
      tags: ["private"],
    });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "v1.encrypted" });
    const fetched = notes.get(note.id);
    expect(fetched?.tags).toBeUndefined();
  });
});
