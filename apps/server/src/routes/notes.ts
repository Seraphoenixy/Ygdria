import type { FastifyInstance } from "fastify";
import { decodeStoredContent, type ContentCodec } from "@ygdria/database";
import type { NoteService } from "@ygdria/domain";
import { NotFoundError, ConflictError } from "@ygdria/domain";
import {
  createNoteSchema,
  archiveNoteSchema,
  placementSchema,
  restoreRevisionSchema,
  updateNoteSchema,
  SYSTEM_TRASH_PLACEMENT_ID,
} from "@ygdria/shared";
import type { SqliteDatabase } from "@ygdria/database";
import { parse, httpError } from "../http/errors.js";
import { parseExpectedVersion } from "../sync/helpers.js";

export interface NoteRouteDeps {
  notes: NoteService;
  sqlite: SqliteDatabase;
}

export function registerNoteRoutes(app: FastifyInstance, deps: NoteRouteDeps) {
  const { notes, sqlite } = deps;

  app.get("/api/v1/tree", async () => notes.tree());

  app.get("/api/v1/placements/:id/children", async (req) =>
    notes.children((req.params as { id: string }).id),
  );

  app.get("/api/v1/placements/:id/size", async (req) =>
    notes.sizeForPlacement((req.params as { id: string }).id),
  );

  app.post("/api/v1/notes", async (req, reply) => {
    const n = notes.create(parse(createNoteSchema, req.body));
    reply.code(201);
    return n;
  });

  app.post("/api/v1/notes/today", async (req, reply) => {
    const input = parse(createNoteSchema, req.body);
    const n = notes.createToday({ title: input.title, content: input.content });
    reply.code(201);
    return n;
  });

  app.post("/api/v1/notes/today/ensure", async (_req, reply) => {
    const n = notes.ensureTodayNote();
    reply.code(201);
    return n;
  });

  app.get("/api/v1/notes/:id", async (req) => {
    const n = notes.get((req.params as { id: string }).id);
    if (!n) throw new NotFoundError();
    return n;
  });

  app.patch("/api/v1/notes/:id", async (req) =>
    notes.update((req.params as { id: string }).id, parse(updateNoteSchema, req.body)),
  );

  app.patch("/api/v1/notes/:id/archive", async (req) => {
    const archivedCount = notes.archiveSubtree(
      (req.params as { id: string }).id,
      parse(archiveNoteSchema, req.body).archived,
    );
    return { archivedCount };
  });

  app.get("/api/v1/notes/:id/revisions", async (req) =>
    notes.revisions((req.params as { id: string }).id),
  );

  app.post("/api/v1/revisions/cleanup", async (req) => {
    const limit = Number((req.body as { limit?: unknown } | undefined)?.limit);
    if (!Number.isInteger(limit) || limit < -1)
      throw new ConflictError("Revision limit must be -1 or a non-negative integer");
    return notes.clearExcessRevisions(limit);
  });

  app.get("/api/v1/notes/:id/revisions/:revisionId", async (req) =>
    notes.revisionContent(
      (req.params as { id: string; revisionId: string }).id,
      (req.params as { id: string; revisionId: string }).revisionId,
    ),
  );

  app.post("/api/v1/notes/:id/revisions/:revisionId/restore", async (req) =>
    notes.restoreRevision(
      (req.params as { id: string; revisionId: string }).id,
      (req.params as { id: string; revisionId: string }).revisionId,
      parse(restoreRevisionSchema, req.body).expectedVersion,
    ),
  );

  app.delete("/api/v1/notes/:id", async (req, reply) => {
    const result = notes.remove((req.params as { id: string }).id);
    reply.code(200);
    return result;
  });

  app.post("/api/v1/notes/:id/restore", async (req) =>
    notes.restore((req.params as { id: string }).id),
  );

  app.delete("/api/v1/notes/:id/permanent", async (req, reply) => {
    const result = notes.purge((req.params as { id: string }).id);
    reply.code(200);
    return result;
  });

  app.get("/api/v1/trash/:id", async (req) => {
    const noteId = (req.params as { id: string }).id;
    const inTrash = sqlite
      .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id=?")
      .get(noteId, SYSTEM_TRASH_PLACEMENT_ID);
    if (!inTrash) throw new NotFoundError();
    const row = sqlite
      .prepare(
        "SELECT id,title,type,content_data,content_codec,content_size,content_hash,plain_text,is_protected,properties_json,version,deleted_at,archived_at,created_at,updated_at FROM notes WHERE id=? AND deleted_at IS NOT NULL",
      )
      .get(noteId) as
      | {
          id: string;
          title: string;
          type: string;
          content_data: Buffer;
          content_codec: string;
          content_size: number;
          content_hash: string;
          plain_text: string;
          is_protected: number;
          properties_json: string;
          version: number;
          deleted_at: number | null;
          archived_at: number | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) throw new NotFoundError();
    return {
      id: row.id,
      title: row.is_protected ? "" : row.title,
      type: row.type,
      content: row.is_protected
        ? null
        : row.type === "code"
          ? decodeStoredContent(row.content_data, row.content_codec as ContentCodec)
          : JSON.parse(decodeStoredContent(row.content_data, row.content_codec as ContentCodec)),
      contentCiphertext: row.is_protected
        ? decodeStoredContent(row.content_data, row.content_codec as ContentCodec)
        : undefined,
      version: row.version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    };
  });

  app.delete("/api/v1/trash", async (req) => {
    const before = Number((req.query as { before?: string }).before);
    return notes.purgeTrash(Number.isSafeInteger(before) && before >= 0 ? before : undefined);
  });

  app.post("/api/v1/placements", async (req, reply) => {
    const b = parse(placementSchema, req.body);
    reply.code(201);
    return notes.addPlacement(b.noteId, b.parentPlacementId, b.position);
  });

  app.patch("/api/v1/placements/:id", async (req) => {
    const b = parse(placementSchema.pick({ parentPlacementId: true, position: true }), req.body);
    notes.movePlacement((req.params as { id: string }).id, b.parentPlacementId, b.position ?? 0);
    return { ok: true };
  });

  app.delete("/api/v1/placements/:id", async (req) => {
    return notes.deletePlacement((req.params as { id: string }).id);
  });

  app.post("/api/v1/placement-deletions/:id/undo", async (req) =>
    notes.undoPlacementDeletion((req.params as { id: string }).id),
  );

  app.patch("/api/v1/notes/:id/protected", async (req) =>
    notes.setProtected(
      (req.params as { id: string }).id,
      req.body as Parameters<typeof notes.setProtected>[1],
    ),
  );

  app.get("/api/v1/search", async (req) =>
    notes.search(
      String((req.query as { q?: string }).q ?? ""),
      String((req.query as { includeArchived?: string }).includeArchived ?? "") === "true",
    ),
  );

  app.get("/api/v1/history", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    return notes.recentHistory(
      Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 200,
      String((req.query as { includeArchived?: string }).includeArchived ?? "") === "true",
    );
  });

  app.get("/api/v1/archived", async () => notes.listArchivedNotes());
}