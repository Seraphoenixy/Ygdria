import type { FastifyInstance } from "fastify";
import { RelationService } from "@ygdria/domain";
import { createRelationSchema } from "@ygdria/shared";
import { httpError } from "../http/errors.js";
import type { SqliteDatabase } from "@ygdria/database";

export interface RelationRouteDeps {
  sqlite: SqliteDatabase;
}

export function registerRelationRoutes(app: FastifyInstance, deps: RelationRouteDeps) {
  const relations = new RelationService({ sqlite: deps.sqlite });

  app.get("/api/v1/relations", async (req) => {
    const noteId = (req.query as { noteId?: string }).noteId;
    if (!noteId) throw httpError(400, "noteId is required");
    return relations.listRelations(noteId);
  });

  app.post("/api/v1/relations", async (req) => {
    const parsed = createRelationSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Invalid relation payload");
    const { sourceNoteId, targetNoteId, relationType } = parsed.data;
    const created = relations.createRelation(sourceNoteId, targetNoteId, relationType);
    if (created) return { ...created, duplicate: false };
    // Duplicate edge already exists — surface the existing record.
    const existing = deps.sqlite
      .prepare(
        "SELECT id,source_note_id sourceNoteId,target_note_id targetNoteId,relation_type relationType,created_at createdAt FROM relations WHERE source_note_id=? AND relation_type=? AND target_note_id=?",
      )
      .get(sourceNoteId, relationType, targetNoteId) as {
      id: string;
      sourceNoteId: string;
      targetNoteId: string;
      relationType: string;
      createdAt: number;
    } | undefined;
    if (!existing) throw httpError(409, "Relation could not be created");
    return { ...existing, duplicate: true };
  });

  app.delete("/api/v1/relations/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    try {
      relations.deleteRelation(id);
    } catch {
      throw httpError(404, "Relation not found");
    }
    return { deleted: true };
  });
}
