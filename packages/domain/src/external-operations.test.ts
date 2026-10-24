import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService } from "./index.js";

function setup() {
  const db = createDatabase(":memory:");
  applyMigrations(db.sqlite);
  return { db, notes: new NoteService(db) };
}
describe("external operations", () => {
  it("preserves untouched Tiptap nodes when appending and replacing a section", () => {
    const { db, notes } = setup();
    try {
      const untouched = {
        type: "paragraph",
        content: [{ type: "text", text: "keep", marks: [{ type: "bold" }] }],
      };
      const doc = {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
          { type: "paragraph", content: [{ type: "text", text: "old" }] },
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Other" }] },
          untouched,
        ],
      };
      const note = notes.create({ title: "sections", content: doc });
      const body = notes.externalSection(note.id, ["Plan"]).content;
      notes.operateExternal(note.id, {
        operation: "replace_section",
        headingPath: ["Plan"],
        oldText: body,
        text: "new",
        expectedVersion: 1,
      });
      expect((notes.get(note.id)!.content as any).content.at(-1)).toEqual(untouched);
      const before = (notes.get(note.id)!.content as any).content;
      notes.operateExternal(note.id, { operation: "append", text: "extra" });
      expect((notes.get(note.id)!.content as any).content.slice(0, before.length)).toEqual(before);
      expect(() =>
        notes.operateExternal(note.id, {
          operation: "replace_section",
          headingPath: ["Plan"],
          oldText: "wrong",
          text: "bad",
          expectedVersion: 3,
        }),
      ).toThrow(/changed/);
      expect(notes.get(note.id)!.version).toBe(3);
    } finally {
      db.sqlite.close();
    }
  });
  it("rejects ambiguous heading paths, tag overflow and protected operations", () => {
    const { db, notes } = setup();
    try {
      const note = notes.createExternal({
        title: "duplicate",
        content: "# Same\n\none\n\n# Same\n\ntwo",
        tags: Array.from({ length: 20 }, (_, i) => `tag${i}`),
      });
      expect(() =>
        notes.operateExternal(note.id, {
          operation: "replace_section",
          headingPath: ["Same"],
          oldText: "one",
          text: "bad",
          expectedVersion: 1,
        }),
      ).toThrow(/found 2/);
      expect(() =>
        notes.operateExternal(note.id, { operation: "tags", addTags: ["overflow"] }),
      ).toThrow(/limits/);
      expect(notes.get(note.id)!.version).toBe(1);
      notes.operateExternal(note.id, {
        operation: "tags",
        addTags: ["replacement"],
        removeTags: ["tag0"],
      });
      expect(notes.get(note.id)!.tags).toContain("replacement");
      expect(notes.get(note.id)!.tags).not.toContain("tag0");
      db.sqlite.prepare("UPDATE notes SET is_protected=1 WHERE id=?").run(note.id);
      for (const operation of ["append", "tags", "replace_section"] as const)
        expect(() => notes.operateExternal(note.id, { operation, text: "x" })).toThrow(/protected/);
    } finally {
      db.sqlite.close();
    }
  });
  it("persists receipts across reopen and rolls failed mutations back", () => {
    const dir = mkdtempSync(join(tmpdir(), "ygdria-receipt-"));
    const path = join(dir, "notes.db");
    let db = createDatabase(path);
    applyMigrations(db.sqlite);
    let notes = new NoteService(db);
    try {
      const input = { title: "once", content: "body" };
      const first = notes.externalMutation("session:create", "key", input, () =>
        notes.createExternal(input),
      );
      db.sqlite.close();
      db = createDatabase(path);
      applyMigrations(db.sqlite);
      notes = new NoteService(db);
      expect(
        notes.externalMutation("session:create", "key", input, () => {
          throw new Error("must not repeat");
        }),
      ).toEqual(first);
      expect(() =>
        notes.externalMutation("session:create", "key", { title: "different" }, () =>
          notes.createExternal(input),
        ),
      ).toThrow(/different/);
      expect(() =>
        notes.externalMutation("session:create", "rollback", input, () => {
          notes.createExternal({ title: "rolled back" });
          throw new Error("fail");
        }),
      ).toThrow("fail");
      expect(
        db.sqlite.prepare("SELECT COUNT(*) count FROM notes WHERE title='rolled back'").get(),
      ).toEqual({ count: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) count FROM etapi_receipts").get()).toEqual({
        count: 1,
      });
    } finally {
      db.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
