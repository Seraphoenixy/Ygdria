import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService, RelationService } from "./index.js";

describe("note_links projection", () => {
  let db: ReturnType<typeof createDatabase>;
  let notes: NoteService;
  let relations: RelationService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    notes = new NoteService(db);
    relations = new RelationService(db);
  });

  const linksOf = (noteId: string) =>
    (
      db.sqlite.prepare("SELECT target_note_id targetNoteId FROM note_links WHERE note_id=? ORDER BY target_note_id").all(noteId) as Array<{ targetNoteId: string }>
    ).map((row) => row.targetNoteId);

  it("projects body note references on create and keeps them current on update", () => {
    const target = notes.create({ title: "Target" }).id;
    const source = notes.create({
      title: "Source",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "noteReference", attrs: { noteId: target, title: "Target" } }] }],
      },
    }).id;
    expect(linksOf(source)).toEqual([target]);

    // Rewriting the body without the link drops the row.
    notes.update(source, {
      content: { type: "doc", content: [{ type: "paragraph" }] },
      expectedVersion: 1,
    });
    expect(linksOf(source)).toEqual([]);
  });

  it("cascades with the source note and filters dangling targets in the graph", () => {
    const target = notes.create({ title: "Target" }).id;
    const source = notes.create({
      title: "Source",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [
            { type: "noteReference", attrs: { noteId: target, title: "Target" } },
            { type: "noteReference", attrs: { noteId: "00000000-0000-4000-8000-0000000000ff", title: "Ghost" } },
          ] },
        ],
      },
    }).id;

    const graph = relations.graph();
    expect(graph.edges).toContainEqual({ source, target, kind: "link" });
    // Dangling targets never become edges.
    expect(graph.edges.filter((edge) => edge.target === "00000000-0000-4000-8000-0000000000ff")).toHaveLength(0);

    notes.purge(source);
    expect(linksOf(source)).toEqual([]);
  });

  it("skips protected and code notes entirely", () => {
    const note = notes.create({ title: "Protected" });
    notes.setProtected(note.id, { protected: true, contentCiphertext: "enc" });
    const code = notes.create({ title: "Code", type: "code", code: "const a = 1;" });
    expect(linksOf(note.id)).toEqual([]);
    expect(linksOf(code.id)).toEqual([]);
  });
});
