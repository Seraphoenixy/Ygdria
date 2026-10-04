import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService, RelationService } from "./index.js";

describe("RelationService", () => {
  let db: ReturnType<typeof createDatabase>;
  let notes: NoteService;
  let relations: RelationService;
  let a: string;
  let b: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    notes = new NoteService(db);
    relations = new RelationService(db);
    a = notes.create({ title: "A" }).id;
    b = notes.create({ title: "B" }).id;
  });

  it("records a sync change on create and delete", () => {
    const created = relations.createRelation(a, b, "related");
    expect(created).not.toBeNull();
    const log = db.sqlite
      .prepare("SELECT entity_type entityType,entity_id entityId,change_kind changeKind FROM sync_change_log WHERE entity_type='relation'")
      .all() as Array<{ entityType: string; entityId: string; changeKind: string }>;
    expect(log).toContainEqual({ entityType: "relation", entityId: created!.id, changeKind: "created" });

    relations.deleteRelation(created!.id);
    const deletedLog = db.sqlite
      .prepare(
        "SELECT change_kind changeKind FROM sync_change_log WHERE entity_type='relation' AND entity_id=? AND change_kind='deleted'",
      )
      .get(created!.id) as { changeKind: string } | undefined;
    expect(deletedLog).toBeDefined();
  });

  it("rejects duplicate edges via the unique index", () => {
    relations.createRelation(a, b, "uses");
    const second = relations.createRelation(a, b, "uses");
    expect(second).toBeNull();
    const count = db.sqlite
      .prepare("SELECT COUNT(*) c FROM relations WHERE source_note_id=? AND target_note_id=?")
      .get(a, b) as { c: number };
    expect(count.c).toBe(1);
  });

  it("rejects self-relation, reserved endpoints and missing notes", () => {
    expect(() => relations.createRelation(a, a, "related")).toThrow();
    expect(() => relations.createRelation(a, "00000000-0000-4000-8000-000000000003", "related")).toThrow();
    expect(() => relations.createRelation(a, "does-not-exist", "related")).toThrow();
  });

  it("lists outgoing and incoming relations with peer titles", () => {
    relations.createRelation(a, b, "uses");
    const listing = relations.listRelations(a);
    expect(listing.outgoing).toHaveLength(1);
    expect(listing.outgoing[0]?.peerTitle).toBe("B");
    const back = relations.listRelations(b);
    expect(back.incoming).toHaveLength(1);
    expect(back.incoming[0]?.peerTitle).toBe("A");
  });

  it("projects a graph from relations and body note links", () => {
    relations.createRelation(a, b, "uses");
    const c = notes.create({
      title: "C",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "noteReference", attrs: { noteId: b, title: "B" } }] }] },
    }).id;
    // A link pointing at a deleted note and a self-link must not become edges.
    const ghost = notes.create({ title: "Ghost" }).id;
    notes.create({
      title: "Dangling",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "noteReference", attrs: { noteId: ghost, title: "Ghost" } }, { type: "noteReference", attrs: { noteId: a, title: "A" } }] }] },
    });
    notes.remove(ghost);

    const graph = relations.graph();
    const nodeIds = graph.nodes.map((node) => node.id).sort();
    expect(nodeIds).toContain(a);
    expect(nodeIds).toContain(b);
    expect(nodeIds).toContain(c);
    expect(nodeIds).not.toContain(ghost);
    expect(graph.edges).toContainEqual({ source: a, target: b, kind: "relation" });
    expect(graph.edges).toContainEqual({ source: c, target: b, kind: "link" });
    expect(graph.edges).toContainEqual({ source: expect.any(String), target: a, kind: "link" });
    expect(graph.edges.filter((edge) => edge.kind === "relation")).toHaveLength(1);
  });
});
