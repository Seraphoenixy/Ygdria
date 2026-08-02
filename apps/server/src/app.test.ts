import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { buildApp } from "./app.js";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService } from "@ygdria/domain";
import {
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_ROOT_PLACEMENT_ID,
  SYSTEM_TRASH_NOTE_ID,
} from "@ygdria/shared";
describe("ETAPI", () => {
  const file = ":memory:";
  let app: any;
  beforeAll(async () => {
    app = buildApp({ databaseUrl: file });
  });
  afterAll(() => app.close());
  it("writes and reads markdown", async () => {
    const n = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Test" } })
    ).json();
    const firstSave = await app.inject({
      method: "PUT",
      url: `/etapi/notes/${n.id}/content`,
      headers: { "content-type": "text/markdown", "if-match": String(n.version) },
      payload: "# Hello",
    });
    const repeatedSave = await app.inject({
      method: "PUT",
      url: `/etapi/notes/${n.id}/content`,
      headers: {
        "content-type": "text/markdown",
        "if-match": String(firstSave.json().version),
      },
      payload: "# Hello",
    });
    expect(repeatedSave.json().version).toBe(firstSave.json().version);
    const r = await app.inject(`/etapi/notes/${n.id}/content?format=markdown`);
    expect(r.body).toContain("Hello");
  });
  it("ensures today's calendar day without creating a child note", async () => {
    const day = (
      await app.inject({ method: "POST", url: "/api/v1/notes/today/ensure" })
    ).json();
    const tree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const dayPlacement = tree.find((item: any) => item.noteId === day.id);
    expect(dayPlacement).toBeTruthy();
    expect(tree.filter((item: any) => item.parentPlacementId === dayPlacement.placementId)).toHaveLength(0);
  });
  it("returns a conflict instead of silently overwriting a stale version", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Concurrent" } })
    ).json();
    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/notes/${note.id}`,
      payload: { title: "First writer", expectedVersion: note.version },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/notes/${note.id}`,
      payload: { title: "Second writer", expectedVersion: note.version },
    });
    expect(stale.statusCode).toBe(409);
  });
  it("can independently undo a placement deletion and restore an orphaned note", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Undo me" } })
    ).json();
    const before = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const placement = before.find((item: any) => item.noteId === note.id);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/placements/${placement.placementId}`,
    });
    expect(deleted.statusCode).toBe(200);
    const undoId = deleted.json().undoId;
    expect((await app.inject(`/api/v1/notes/${note.id}`)).statusCode).toBe(404);
    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/placement-deletions/${undoId}/undo`,
    });
    expect(restored.statusCode).toBe(200);
    expect((await app.inject(`/api/v1/notes/${note.id}`)).statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    expect(after.find((item: any) => item.placementId === placement.placementId)).toBeTruthy();
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/placement-deletions/${undoId}/undo` }))
        .statusCode,
    ).toBe(404);
  });
  it("protects the root and trash system placements from ordinary operations", async () => {
    const tree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const trash = tree.find((item: any) => item.noteId === SYSTEM_TRASH_NOTE_ID);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/placements/${trash.placementId}` }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/placements",
          payload: { noteId: SYSTEM_TRASH_NOTE_ID, parentPlacementId: SYSTEM_ROOT_PLACEMENT_ID },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("does not touch note updated_at when only a placement moves", () => {
    const store = createDatabase(":memory:");
    applyMigrations(store.sqlite);
    const notes = new NoteService(store);
    const note = notes.create({ title: "Placement timestamp" });
    const placement = store.sqlite
      .prepare("SELECT id FROM placements WHERE note_id=?")
      .get(note.id) as { id: string };
    store.sqlite.prepare("UPDATE notes SET updated_at=? WHERE id=?").run(1, note.id);
    notes.movePlacement(placement.id, SYSTEM_ROOT_PLACEMENT_ID, 9);
    expect(
      (
        store.sqlite.prepare("SELECT updated_at FROM notes WHERE id=?").get(note.id) as {
          updated_at: number;
        }
      ).updated_at,
    ).toBe(1);
    store.sqlite.close();
  });
  it("creates one fixed root and places new notes below it", async () => {
    const tree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const root = tree.find((item: any) => item.placementId === SYSTEM_ROOT_PLACEMENT_ID);
    expect(root).toMatchObject({
      noteId: SYSTEM_ROOT_NOTE_ID,
      parentPlacementId: null,
      title: "Root",
    });
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Child" } })
    ).json();
    const updatedTree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    expect(updatedTree.find((item: any) => item.noteId === note.id)).toMatchObject({
      parentPlacementId: SYSTEM_ROOT_PLACEMENT_ID,
    });
  });
  it("declares cascade foreign keys for note-owned rows and attachment links", () => {
    const sqlite = createDatabase(":memory:").sqlite;
    applyMigrations(sqlite);
    const cascadeFor = (table: string, column: string) =>
      (sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as any[]).some(
        (foreignKey) => foreignKey.from === column && foreignKey.on_delete === "CASCADE",
      );
    expect(cascadeFor("placements", "note_id")).toBe(true);
    expect(cascadeFor("placements", "parent_placement_id")).toBe(true);
    expect(cascadeFor("relations", "source_note_id")).toBe(true);
    expect(cascadeFor("relations", "target_note_id")).toBe(true);
    expect(cascadeFor("revisions", "note_id")).toBe(true);
    sqlite.close();
  });
  it("accepts only the defined note types", () => {
    const sqlite = createDatabase(":memory:").sqlite;
    applyMigrations(sqlite);
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "invalid-type",
          "Invalid",
          "script",
          Buffer.from('{"type":"doc"}'),
          "identity",
          14,
          "hash",
          "",
          "{}",
          1,
          null,
          1,
          1,
        ),
    ).toThrow(/note type|CHECK/i);
    sqlite.close();
  });
  it("rejects placement cycles even when SQL bypasses the API", () => {
    const sqlite = createDatabase(":memory:").sqlite;
    applyMigrations(sqlite);
    const timestamp = Date.now();
    const insertNote = sqlite.prepare(
      "INSERT INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const insertPlacement = sqlite.prepare(
      "INSERT INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    );
    for (const noteId of ["cycle-note-a", "cycle-note-b"]) {
      insertNote.run(
        noteId,
        noteId,
        "text",
        Buffer.from('{"type":"doc"}'),
        "identity",
        14,
        "hash",
        "",
        "{}",
        1,
        null,
        timestamp,
        timestamp,
      );
    }
    insertPlacement.run(
      "cycle-a",
      "cycle-note-a",
      SYSTEM_ROOT_PLACEMENT_ID,
      1,
      timestamp,
      timestamp,
    );
    insertPlacement.run("cycle-b", "cycle-note-b", "cycle-a", 1, timestamp, timestamp);
    expect(() =>
      sqlite
        .prepare("UPDATE placements SET parent_placement_id=? WHERE id=?")
        .run("cycle-b", "cycle-a"),
    ).toThrow(/ancestor/);
    expect(() =>
      sqlite
        .prepare("UPDATE placements SET parent_placement_id=? WHERE id=?")
        .run("cycle-a", "cycle-a"),
    ).toThrow();
    sqlite.close();
  });
  it("validates attachment payloads and serves unknown content as a download", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "附件" } })
    ).json();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hash = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}?noteId=${note.id}&filename=image.txt`,
      headers: { "content-type": "application/octet-stream" },
      payload: png,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().mimeType).toBe("image/png");
    const downloaded = await app.inject(`/api/v1/attachments/${uploaded.json().id}`);
    expect(downloaded.headers["content-disposition"]).toBeUndefined();
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("accepts SVG attachments when their contents identify them as SVG", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "SVG" } })
    ).json();
    // draw.io exports add a standard XML prolog before the SVG root element.
    const svg = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!-- draw.io -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');
    const hash = `sha256:${createHash("sha256").update(svg).digest("hex")}`;
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}?noteId=${note.id}&filename=diagram.svg`,
      headers: { "content-type": "application/octet-stream" },
      payload: svg,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().mimeType).toBe("image/svg+xml");
    const downloaded = await app.inject(`/api/v1/attachments/${uploaded.json().id}`);
    expect(downloaded.headers["content-type"]).toContain("image/svg+xml");
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("accepts unknown attachment formats and serves them as downloads", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "文件" } })
    ).json();
    const file = Buffer.from("custom binary payload");
    const hash = `sha256:${createHash("sha256").update(file).digest("hex")}`;
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}?noteId=${note.id}&filename=archive.dat`,
      headers: { "content-type": "application/octet-stream" },
      payload: file,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json().mimeType).toBe("application/octet-stream");
    const downloaded = await app.inject(`/api/v1/attachments/${uploaded.json().id}`);
    expect(downloaded.headers["content-disposition"]).toBe("attachment");
  });
  it("returns a stable validation error instead of schema details", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: 42 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Invalid request data");
  });
  it("does not disclose internal exception details in 5xx responses", async () => {
    const localApp = buildApp({ databaseUrl: ":memory:", prettyLogs: false });
    localApp.get("/test-only/internal-error", async () => {
      throw new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: notes.id");
    });
    const response = await localApp.inject("/test-only/internal-error");
    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toBe("Internal server error");
    expect(response.body).not.toContain("SQLITE_CONSTRAINT");
    await localApp.close();
  });
});

describe("Sync deletion", () => {
  const file = ":memory:";
  let app: any;
  beforeAll(async () => {
    app = buildApp({ databaseUrl: file });
  });
  afterAll(() => app.close());

  it("creates a trash placement when syncing a note.deleted", async () => {
    // Create a note via the normal API.
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Sync delete me" } })
    ).json();
    // Use a timestamp strictly greater than the note's updated_at to ensure
    // the sync update condition (updated_at < timestamp) is satisfied.
    const updatedAt = Date.now() + 1000;
    // Simulate a sync push with a note.deleted change.
    const pushResult = await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      payload: {
        changes: [{ changeId: 1, entityType: "note", entityId: note.id, changeKind: "deleted", data: null, createdAt: updatedAt }],
      },
    });
    expect(pushResult.statusCode).toBe(200);
    expect(pushResult.json().applied).toBe(1);
    // The note should now appear in the tree under the trash.
    const tree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const trashPlacement = tree.find((item: any) => item.noteId === note.id && item.isTrashed);
    expect(trashPlacement).toBeTruthy();
    // It should be fetchable via the trash endpoint.
    const trashed = await app.inject(`/api/v1/trash/${note.id}`);
    expect(trashed.statusCode).toBe(200);
  });

  it("restores a sync-deleted note via fallback when no deletion snapshot exists", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Restore fallback" } })
    ).json();
    // Delete via sync (no local snapshot).
    // Use a timestamp strictly greater than the note's updated_at.
    const updatedAt = Date.now() + 1000;
    await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      payload: {
        changes: [{ changeId: 1, entityType: "note", entityId: note.id, changeKind: "deleted", data: null, createdAt: updatedAt }],
      },
    });
    // Restore via the API.
    const restored = await app.inject({ method: "POST", url: `/api/v1/notes/${note.id}/restore` });
    expect(restored.statusCode).toBe(200);
    // The note should be back in the tree (not trashed).
    const tree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const placement = tree.find((item: any) => item.noteId === note.id);
    expect(placement).toBeTruthy();
    expect(placement.isTrashed).toBeFalsy();
    // The note content should be accessible again.
    const fetched = await app.inject(`/api/v1/notes/${note.id}`);
    expect(fetched.statusCode).toBe(200);
  });

  it("removes a locally generated trash placement when a peer restores a note", async () => {
    const note = (
      await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title: "Peer restore" } })
    ).json();
    const originalChange = (await app.inject("/api/v1/sync/changes?cursor=0")).json().changes
      .find((change: any) => change.entityType === "note" && change.entityId === note.id);
    const deletedAt = Date.now() + 1_000;
    await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      payload: { changes: [{ changeId: 1, entityType: "note", entityId: note.id, changeKind: "deleted", data: null, createdAt: deletedAt }] },
    });

    const restoredAt = deletedAt + 1_000;
    const restoreResult = await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      payload: {
        changes: [{
          changeId: 2,
          entityType: "note",
          entityId: note.id,
          changeKind: "updated",
          createdAt: restoredAt,
          data: { ...originalChange.data, updatedAt: restoredAt, deletedAt: null },
        }],
      },
    });
    expect(restoreResult.statusCode).toBe(200);
    const tree = (await app.inject({ method: "GET", url: "/api/v1/tree" })).json();
    const placements = tree.filter((item: any) => item.noteId === note.id);
    expect(placements).toHaveLength(1);
    expect(placements[0].isTrashed).toBeFalsy();
  });

  it("purges all deleted notes regardless of trash placement", async () => {
    const store = createDatabase(":memory:");
    applyMigrations(store.sqlite);
    const notes = new NoteService(store);
    // Create a normal deleted note (has trash placement).
    const normal = notes.create({ title: "Normal delete" });
    notes.remove(normal.id);
    // Create a ghost record: deleted_at set but no trash placement.
    const ghost = notes.create({ title: "Ghost record" });
    store.sqlite.prepare("UPDATE notes SET deleted_at=?,updated_at=? WHERE id=?").run(Date.now(), Date.now(), ghost.id);
    store.sqlite.prepare("DELETE FROM placements WHERE note_id=?").run(ghost.id);
    // purgeTrash should find and delete both.
    const result = notes.purgeTrash();
    expect(result.count).toBe(2);
    // Verify both notes are gone.
    const remainingTree = (notes as any).tree();
    expect(remainingTree.find((item: any) => item.noteId === normal.id)).toBeUndefined();
    expect(remainingTree.find((item: any) => item.noteId === ghost.id)).toBeUndefined();
    store.sqlite.close();
  });

  it("repairs ghost records during maintenance", async () => {
    const store = createDatabase(":memory:");
    applyMigrations(store.sqlite);
    const notes = new NoteService(store);
    // Create a ghost record: deleted_at set but no trash placement.
    const note = notes.create({ title: "Ghost" });
    store.sqlite.prepare("UPDATE notes SET deleted_at=?,updated_at=? WHERE id=?").run(Date.now(), Date.now(), note.id);
    store.sqlite.prepare("DELETE FROM placements WHERE note_id=?").run(note.id);
    // Simulate maintenance repair by running the ghost-repair logic.
    const { MaintenanceRunner } = await import("./maintenance.js");
    const runner = new MaintenanceRunner(":memory:", store.sqlite);
    runner.start();
    // Poll for the async task to complete instead of a fixed timeout.
    const maxWait = 5000;
    const pollInterval = 50;
    let waited = 0;
    let status;
    while (waited < maxWait) {
      status = runner.getStatus();
      if (status?.status === "succeeded" || status?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      waited += pollInterval;
    }
    expect(status?.status).toBe("succeeded");
    // The ghost note should now have a trash placement.
    const tree = (notes as any).tree();
    const placement = tree.find((item: any) => item.noteId === note.id);
    expect(placement).toBeTruthy();
    expect(placement.isTrashed).toBeTruthy();
    store.sqlite.close();
  });
});

describe("relations route", () => {
  let app: any;
  beforeAll(() => {
    app = buildApp({ databaseUrl: ":memory:" });
  });
  afterAll(() => app.close());

  async function createNote(title: string) {
    return (await app.inject({ method: "POST", url: "/api/v1/notes", payload: { title } })).json();
  }

  it("creates, lists and deletes a relation", async () => {
    const a = await createNote("Alpha");
    const b = await createNote("Beta");

    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/relations",
        payload: { sourceNoteId: a.id, targetNoteId: b.id, relationType: "uses" },
      })
    ).json();
    expect(created.id).toBeTruthy();
    expect(created.duplicate).toBe(false);

    // Duplicate edge is reported as a 200 with the existing record.
    const dup = (
      await app.inject({
        method: "POST",
        url: "/api/v1/relations",
        payload: { sourceNoteId: a.id, targetNoteId: b.id, relationType: "uses" },
      })
    ).json();
    expect(dup.duplicate).toBe(true);
    expect(dup.id).toBe(created.id);

    const fromA = (await app.inject({ method: "GET", url: `/api/v1/relations?noteId=${a.id}` })).json();
    expect(fromA.outgoing).toHaveLength(1);
    expect(fromA.outgoing[0].peerTitle).toBe("Beta");
    const fromB = (await app.inject({ method: "GET", url: `/api/v1/relations?noteId=${b.id}` })).json();
    expect(fromB.incoming).toHaveLength(1);
    expect(fromB.incoming[0].peerTitle).toBe("Alpha");

    const deleted = (
      await app.inject({ method: "DELETE", url: `/api/v1/relations/${created.id}` })
    ).json();
    expect(deleted.deleted).toBe(true);
    const after = (await app.inject({ method: "GET", url: `/api/v1/relations?noteId=${a.id}` })).json();
    expect(after.outgoing).toHaveLength(0);
  });

  it("rejects a self-relation and missing noteId", async () => {
    const a = await createNote("Gamma");
    const self = await app.inject({
      method: "POST",
      url: "/api/v1/relations",
      payload: { sourceNoteId: a.id, targetNoteId: a.id, relationType: "related" },
    });
    expect(self.statusCode).toBe(404);
    const noId = await app.inject({ method: "GET", url: "/api/v1/relations" });
    expect(noId.statusCode).toBe(400);
  });
});
