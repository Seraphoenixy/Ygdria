import { describe, it, expect } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService, RelationService } from "@ygdria/domain";
import { CALENDAR_NOTE_ID, SYSTEM_ROOT_NOTE_ID, SYSTEM_ROOT_PLACEMENT_ID, SYSTEM_TRASH_NOTE_ID, SYSTEM_TRASH_PLACEMENT_ID } from "@ygdria/shared";
import { applySyncChanges, resolveChangeEntities } from "./helpers.js";

function freshDb() {
  const store = createDatabase(":memory:");
  applyMigrations(store.sqlite);
  return store;
}

/** Drain A's sync change log into B via applySyncChanges, advancing a cursor. */
function sync(peerA: ReturnType<typeof freshDb>, peerB: ReturnType<typeof freshDb>, cursor: { id: number }) {
  const raw = peerA.sqlite
    .prepare(
      "SELECT id,entity_type entityType,entity_id entityId,change_kind changeKind,created_at createdAt FROM sync_change_log WHERE id>? ORDER BY id",
    )
    .all(cursor.id) as Array<{
    id: number;
    entityType: string;
    entityId: string;
    changeKind: string;
    createdAt: number;
  }>;
  cursor.id = raw.reduce((m, c) => Math.max(m, c.id), cursor.id);
  // Resolve real entity snapshots (note bodies, etc.) the way the sync pull
  // endpoint does, so creations actually materialize on the receiver.
  const resolved = resolveChangeEntities(peerA.sqlite, "", raw, true);
  applySyncChanges(
    peerB.sqlite,
    resolved.map((c) => ({
      changeId: c.changeId,
      entityType: c.entityType,
      entityId: c.entityId,
      changeKind: c.changeKind,
      data: c.data,
      createdAt: c.createdAt,
    })),
    false,
  );
}

describe("cross-device purge propagation", () => {
  it("hard-deletes a locally-trashed note when the peer purges its trash", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const notesA = new NoteService(peerA);
    const notesB = new NoteService(peerB);
    const cursor = { id: 0 };

    // Real incremental sync: A creates -> B gets it, A trashes -> B trashes it.
    const note = notesA.create({ title: "To be purged" });
    sync(peerA, peerB, cursor);
    notesA.remove(note.id);
    sync(peerA, peerB, cursor);

    // Sanity: B has the note in its trash.
    const before = peerB.sqlite
      .prepare("SELECT deleted_at deletedAt FROM notes WHERE id=?")
      .get(note.id) as { deletedAt: number | null };
    expect(before.deletedAt).not.toBeNull();

    // A purges its trash (now records the deletion in the sync log).
    notesA.purgeTrash();

    // B applies the purge and should hard-delete the already-trashed note so
    // the two databases stay consistent.
    sync(peerA, peerB, cursor);

    expect(peerB.sqlite.prepare("SELECT 1 FROM notes WHERE id=?").get(note.id)).toBeUndefined();
    expect(
      peerB.sqlite
        .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id=?")
        .get(note.id, SYSTEM_TRASH_PLACEMENT_ID),
    ).toBeUndefined();
  });

  it("keeps an active (restored) note recoverable instead of hard-deleting on a peer deletion", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const notesA = new NoteService(peerA);
    const notesB = new NoteService(peerB);
    const cursor = { id: 0 };

    const note = notesA.create({ title: "Conflict" });
    sync(peerA, peerB, cursor);
    notesA.remove(note.id);
    sync(peerA, peerB, cursor);

    // B restores the note so it is active locally.
    notesB.restore(note.id);
    // A purges its trash.
    notesA.purgeTrash();
    // B applies A's deletion of an active note: it should soft-delete (trash)
    // to stay recoverable, never silently hard-delete restored content.
    sync(peerA, peerB, cursor);

    const row = peerB.sqlite
      .prepare("SELECT deleted_at deletedAt FROM notes WHERE id=?")
      .get(note.id) as { deletedAt: number | null };
    expect(row).not.toBeUndefined();
    expect(row.deletedAt).not.toBeNull();
  });

  it("removes the trashed note's former tree positions on the peer", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const notesA = new NoteService(peerA);
    const notesB = new NoteService(peerB);
    const cursor = { id: 0 };

    const note = notesA.create({ title: "Trashed note" });
    sync(peerA, peerB, cursor);

    // Before trashing, B holds exactly the note's original (root) placement.
    const beforeCount = (
      peerB.sqlite.prepare("SELECT COUNT(*) c FROM placements WHERE note_id=?").get(note.id) as { c: number }
    ).c;
    expect(beforeCount).toBe(1);

    // A moves the note to the trash (which deletes its original placements).
    notesA.remove(note.id);
    sync(peerA, peerB, cursor);

    // B must have soft-deleted the note and created a trash placement, while the
    // former non-trash placement is gone so the two databases stay consistent.
    const deletedAt = (
      peerB.sqlite
        .prepare("SELECT deleted_at deletedAt FROM notes WHERE id=?")
        .get(note.id) as { deletedAt: number | null }
    ).deletedAt;
    expect(deletedAt).not.toBeNull();
    expect(
      peerB.sqlite
        .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id<>?")
        .get(note.id, SYSTEM_TRASH_PLACEMENT_ID),
    ).toBeUndefined();
    expect(
      peerB.sqlite
        .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id=?")
        .get(note.id, SYSTEM_TRASH_PLACEMENT_ID),
    ).toBeDefined();
  });

  it("restores a trashed note on the peer without leaving stale placements", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const notesA = new NoteService(peerA);
    const notesB = new NoteService(peerB);
    const cursor = { id: 0 };

    const note = notesA.create({ title: "Restore me" });
    sync(peerA, peerB, cursor);
    notesA.remove(note.id);
    sync(peerA, peerB, cursor);

    // A restores the note locally.
    notesA.restore(note.id);
    sync(peerA, peerB, cursor);

    // B should converge to the restored state: note active (no trash placement)
    // and the original tree placement recreated, with no leftover trash entry.
    const row = peerB.sqlite
      .prepare("SELECT deleted_at deletedAt FROM notes WHERE id=?")
      .get(note.id) as { deletedAt: number | null };
    expect(row.deletedAt).toBeNull();
    expect(
      peerB.sqlite
        .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id<>?")
        .get(note.id, SYSTEM_TRASH_PLACEMENT_ID),
    ).toBeDefined();
    expect(
      peerB.sqlite
        .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id=?")
        .get(note.id, SYSTEM_TRASH_PLACEMENT_ID),
    ).toBeUndefined();
  });
});

describe("atomic sibling-order sync", () => {
  it("converges every sibling after a desktop-style reorder", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const notesA = new NoteService(peerA);
    const cursor = { id: 0 };
    const a = notesA.create({ title: "A" });
    const b = notesA.create({ title: "B" });
    const c = notesA.create({ title: "C" });
    sync(peerA, peerB, cursor);
    const cPlacement = peerA.sqlite.prepare("SELECT id FROM placements WHERE note_id=?").get(c.id) as { id: string };

    notesA.movePlacement(cPlacement.id, SYSTEM_ROOT_PLACEMENT_ID, 0);
    sync(peerA, peerB, cursor);

    const order = (store: ReturnType<typeof freshDb>) => store.sqlite
      .prepare("SELECT note_id noteId FROM placements WHERE parent_placement_id=? AND note_id NOT IN (?,?,?) ORDER BY position,id")
      .all(SYSTEM_ROOT_PLACEMENT_ID, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID) as Array<{ noteId: string }>;
    expect(order(peerB).map((row) => row.noteId)).toEqual(order(peerA).map((row) => row.noteId));
    expect(order(peerB).map((row) => row.noteId)).toEqual([c.id, a.id, b.id]);
  });
});

describe("cross-device attachment deletion", () => {
  const ORPHAN_ID = "22222222-2222-2222-2222-222222222222";
  const KEEP_ID = "11111111-1111-1111-1111-111111111111";

  function insertAttachment(store: ReturnType<typeof freshDb>, id: string, storageKey: string) {
    store.sqlite
      .prepare(
        "INSERT INTO attachments (id,filename,mime_type,size,storage_key,content_hash,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, "file.txt", "text/plain", 4, storageKey, `sha256:${id}`, Date.now());
  }

  it("drops an unreferenced attachment on the peer when an explicit deletion is synced", () => {
    const peerB = freshDb();
    insertAttachment(peerB, ORPHAN_ID, "attachments/orphan");

    applySyncChanges(
      peerB.sqlite,
      [
        {
          changeId: 1,
          entityType: "attachment",
          entityId: ORPHAN_ID,
          changeKind: "deleted",
          data: null,
          createdAt: Date.now(),
        },
      ],
      false,
    );

    // The peer reconciles the explicit deletion through reference-aware cleanup
    // and removes the now-orphaned metadata row so the two databases converge.
    expect(peerB.sqlite.prepare("SELECT 1 FROM attachments WHERE id=?").get(ORPHAN_ID)).toBeUndefined();
  });

  it("retains a still-referenced attachment despite a peer deletion change", () => {
    const peerB = freshDb();
    const notesB = new NoteService(peerB);
    const note = notesB.create({ title: "Keeps its attachment" });
    insertAttachment(peerB, KEEP_ID, "attachments/keep");

    // Make the note reference the attachment so the cleanup must keep it.
    const content = JSON.stringify({
      type: "doc",
      content: [{ type: "image", attrs: { src: `/api/v1/attachments/${KEEP_ID}` } }],
    });
    peerB.sqlite
      .prepare("UPDATE notes SET content_data=?,content_codec=?,content_hash=? WHERE id=?")
      .run(Buffer.from(content), "identity", `sha256:${KEEP_ID}`, note.id);

    applySyncChanges(
      peerB.sqlite,
      [
        {
          changeId: 1,
          entityType: "attachment",
          entityId: KEEP_ID,
          changeKind: "deleted",
          data: null,
          createdAt: Date.now(),
        },
      ],
      false,
    );

    // Still referenced locally, so the reference-aware cleanup must not delete it.
    expect(peerB.sqlite.prepare("SELECT 1 FROM attachments WHERE id=?").get(KEEP_ID)).toBeDefined();
  });
});

describe("cross-device relation sync", () => {
  function createNotesOn(store: ReturnType<typeof freshDb>) {
    const notes = new NoteService(store);
    const a = notes.create({ title: "A" }).id;
    const b = notes.create({ title: "B" }).id;
    return { a, b };
  }

  it("propagates a created relation to a peer and backlinks resolve", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const { a, b } = createNotesOn(peerA);
    createNotesOn(peerB); // same note ids so the edge can land on B
    const relationsA = new RelationService(peerA);
    const cursor = { id: 0 };

    relationsA.createRelation(a, b, "uses");
    sync(peerA, peerB, cursor);

    const edge = peerB.sqlite
      .prepare("SELECT source_note_id,target_note_id,relation_type FROM relations WHERE source_note_id=? AND target_note_id=?")
      .get(a, b) as { source_note_id: string; target_note_id: string; relation_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge?.relation_type).toBe("uses");
  });

  it("propagates a deleted relation to a peer", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const { a, b } = createNotesOn(peerA);
    createNotesOn(peerB);
    const relationsA = new RelationService(peerA);
    const cursor = { id: 0 };

    const created = relationsA.createRelation(a, b, "related");
    sync(peerA, peerB, cursor);
    expect(peerB.sqlite.prepare("SELECT 1 FROM relations WHERE id=?").get(created!.id)).toBeDefined();

    relationsA.deleteRelation(created!.id);
    sync(peerA, peerB, cursor);
    expect(peerB.sqlite.prepare("SELECT 1 FROM relations WHERE id=?").get(created!.id)).toBeUndefined();
  });

  it("refuses to resurrect a relation the peer deleted after its creation", () => {
    const peerA = freshDb();
    const peerB = freshDb();
    const { a, b } = createNotesOn(peerA);
    createNotesOn(peerB);
    const relationsA = new RelationService(peerA);

    // Seed an edge with an explicitly old creation timestamp directly so the
    // anti-resurrection guard has a deterministic comparison point.
    const R = "99999999-9999-9999-9999-999999999999";
    const OLD = 1000;
    peerA.sqlite
      .prepare(
        "INSERT INTO relations (id,source_note_id,target_note_id,relation_type,created_at) VALUES (?,?,?,?,?)",
      )
      .run(R, a, b, "related", OLD);
    peerA.sqlite
      .prepare("INSERT INTO sync_change_log (entity_type,entity_id,change_kind,created_at) VALUES ('relation',?,?,?)")
      .run(R, "created", OLD);

    // B receives the creation.
    sync(peerA, peerB, { id: 0 });
    expect(peerB.sqlite.prepare("SELECT 1 FROM relations WHERE id=?").get(R)).toBeDefined();

    // B deletes the edge; the AFTER DELETE trigger writes a tombstone with a
    // timestamp far newer than OLD.
    peerB.sqlite.prepare("DELETE FROM relations WHERE id=?").run(R);
    const tombstone = peerB.sqlite
      .prepare("SELECT deleted_at deletedAt FROM sync_tombstones WHERE entity_type='relation' AND entity_id=?")
      .get(R) as { deletedAt: number };
    expect(tombstone.deletedAt).toBeGreaterThan(OLD);

    // A replays the old creation change. The guard must reject resurrection.
    applySyncChanges(
      peerB.sqlite,
      [
        {
          changeId: 999,
          entityType: "relation",
          entityId: R,
          changeKind: "created",
          data: { id: R, sourceNoteId: a, targetNoteId: b, relationType: "related", createdAt: OLD },
          createdAt: OLD,
        },
      ],
      false,
    );
    expect(peerB.sqlite.prepare("SELECT 1 FROM relations WHERE id=?").get(R)).toBeUndefined();
  });
});
