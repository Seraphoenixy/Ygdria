import type { FastifyInstance, FastifyRequest } from "fastify";
import type { NoteService } from "@ygdria/domain";
import { noteContentSchema, TAG_MAX_COUNT, TAG_MAX_LENGTH } from "@ygdria/shared";
import { z } from "zod";
import { httpError, parse } from "../http/errors.js";
import type { EtapiScope } from "../security/etapi-sessions.js";
import { parseExpectedVersion } from "../sync/helpers.js";

export interface EtapiRouteDeps {
  notes: NoteService;
}

const tagsSchema = z
  .array(z.string().trim().min(1).max(TAG_MAX_LENGTH))
  .max(TAG_MAX_COUNT);
const booleanQuerySchema = z.enum(["true", "false"]).default("false");
const noteFormatSchema = z.enum(["markdown", "json"]).default("markdown");
const treePageSchema = z.object({
  includeArchived: booleanQuerySchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

const createExternalNoteSchema = z.object({
  title: z.string().trim().min(1).max(500),
  parentPlacementId: z.string().min(1).optional(),
  type: z.enum(["text", "code"]).default("text"),
  content: z.string().max(10_000_000).optional(),
  tags: tagsSchema.optional(),
});

const updateExternalNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    content: z.string().max(10_000_000).optional(),
    tags: tagsSchema.optional(),
    codeLanguage: z.string().trim().min(1).max(64).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.content !== undefined ||
      input.tags !== undefined ||
      input.codeLanguage !== undefined,
    { message: "At least one editable field is required" },
  );

const movePlacementSchema = z.object({
  parentPlacementId: z.string().min(1),
  position: z.number().int().nonnegative().default(0),
});
const externalContentPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  edits: z.array(z.object({
    oldText: z.string().min(1).max(1_000_000),
    newText: z.string().max(1_000_000),
    expectedMatches: z.number().int().positive().max(10_000).optional(),
  })).min(1).max(100),
  dryRun: z.boolean().default(false),
});

function requireScope(req: FastifyRequest, scope: EtapiScope): void {
  // Device credentials and the trusted embedded-server boundary retain full
  // compatibility. Only short-lived ETAPI credentials are scope-restricted.
  if (req.etapiSession && !req.etapiSession.scopes.includes(scope)) {
    throw httpError(403, `ETAPI token lacks required scope: ${scope}`);
  }
}

function canRead(req: FastifyRequest): boolean {
  return !req.etapiSession || req.etapiSession.scopes.includes("notes:read");
}

function minimalMutationResult(note: { id: string; version: number; updatedAt: string }) {
  return { id: note.id, version: note.version, updatedAt: note.updatedAt };
}

export function registerEtapiRoutes(app: FastifyInstance, deps: EtapiRouteDeps) {
  const { notes } = deps;

  app.get("/etapi/tree/roots", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(treePageSchema, req.query, req.log);
    return notes.externalRoots(query.includeArchived === "true", query.limit, query.cursor);
  });

  app.get("/etapi/tree/nodes/:placementId", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(z.object({ includeArchived: booleanQuerySchema }), req.query, req.log);
    return notes.externalNode((req.params as { placementId: string }).placementId, query.includeArchived === "true");
  });

  app.get("/etapi/tree/nodes/:placementId/children", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(treePageSchema, req.query, req.log);
    return notes.externalChildren(
      (req.params as { placementId: string }).placementId,
      query.includeArchived === "true",
      query.limit,
      query.cursor,
    );
  });

  app.get("/etapi/tree/nodes/:placementId/subtree", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(z.object({
      includeArchived: booleanQuerySchema,
      maxDepth: z.coerce.number().int().min(1).max(10).default(1),
      maxNodes: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query, req.log);
    return { items: notes.externalSubtree(
      (req.params as { placementId: string }).placementId,
      query.includeArchived === "true",
      query.maxDepth,
      query.maxNodes,
    ) };
  });

  app.get("/etapi/tree/resolve", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(z.object({
      query: z.string().trim().min(1).max(500),
      parentPlacementId: z.string().min(1).optional(),
      includeArchived: booleanQuerySchema,
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }), req.query, req.log);
    return { items: notes.externalResolve(query.query, query.includeArchived === "true", query.parentPlacementId, query.limit) };
  });

  app.get("/etapi/notes/:id", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(z.object({ format: noteFormatSchema }), req.query, req.log);
    return notes.externalNote((req.params as { id: string }).id, query.format);
  });

  app.post("/etapi/notes", async (req, reply) => {
    requireScope(req, "notes:write");
    const input = parse(createExternalNoteSchema, req.body, req.log);
    const note = notes.createExternal(input);
    reply.code(201);
    return canRead(req)
      ? notes.externalNote(note.id, "markdown")
      : minimalMutationResult(note);
  });

  app.patch("/etapi/notes/:id", async (req) => {
    requireScope(req, "notes:write");
    const id = (req.params as { id: string }).id;
    const input = parse(updateExternalNoteSchema, req.body, req.log);
    const note = notes.updateExternal(id, input);
    return canRead(req)
      ? notes.externalNote(id, "markdown")
      : minimalMutationResult(note);
  });

  app.get("/etapi/search", async (req) => {
    requireScope(req, "notes:read");
    const query = parse(
      z
        .object({
          q: z.string().trim().min(1).max(500).optional(),
          tag: z.string().trim().min(1).max(TAG_MAX_LENGTH).optional(),
          placementId: z.string().min(1).optional(),
          includeArchived: booleanQuerySchema,
        })
        .refine((input) => Boolean(input.q) !== Boolean(input.tag), {
          message: "Provide exactly one of q or tag",
        }),
      req.query,
      req.log,
    );
    return {
      items: query.tag
        ? notes.searchByTag(query.tag, query.includeArchived === "true", query.placementId)
        : notes.search(query.q!, query.includeArchived === "true", query.placementId),
    };
  });

  app.get("/etapi/tags", async (req) => {
    requireScope(req, "notes:read");
    return { items: notes.tagStats() };
  });

  app.patch("/etapi/placements/:id", async (req) => {
    requireScope(req, "notes:write");
    const input = parse(movePlacementSchema, req.body, req.log);
    notes.movePlacement(
      (req.params as { id: string }).id,
      input.parentPlacementId,
      input.position,
    );
    return { ok: true };
  });

  app.get("/etapi/notes/:id/content", async (req, reply) => {
    requireScope(req, "notes:read");
    const query = parse(
      z.object({ format: z.enum(["markdown", "json", "html"]).default("markdown") }),
      req.query,
      req.log,
    );
    const result = notes.content((req.params as { id: string }).id, query.format);
    if (query.format === "markdown") reply.type("text/markdown");
    if (query.format === "html") reply.type("text/html");
    if (query.format === "json" && typeof result === "string") {
      reply.type("application/json");
      return reply.send(JSON.stringify(result));
    }
    return result;
  });

  app.put("/etapi/notes/:id/content", async (req) => {
    requireScope(req, "notes:write");
    const contentType = req.headers["content-type"] ?? "";
    const expectedVersion = parseExpectedVersion(req.headers["if-match"]);
    const isJson = contentType.includes("application/json");
    if (
      !isJson &&
      !contentType.includes("text/markdown") &&
      !contentType.includes("text/plain")
    ) {
      throw httpError(415, "Content-Type must be text/markdown or application/json");
    }
    const body = isJson
      ? parse(noteContentSchema, req.body, req.log)
      : typeof req.body === "string"
        ? req.body
        : (() => {
            throw httpError(400, "Markdown content must be a string");
          })();
    const note = notes.putContent(
      (req.params as { id: string }).id,
      body,
      isJson ? "json" : "markdown",
      expectedVersion,
      req.etapiSession ? true : req.headers["x-ygdria-import"] !== "1",
    );
    return canRead(req) ? note : minimalMutationResult(note);
  });

  app.patch("/etapi/notes/:id/content", async (req) => {
    requireScope(req, "notes:write");
    const input = parse(externalContentPatchSchema, req.body, req.log);
    // A preview includes the resulting body, so do not turn a write-only token
    // into a read capability.
    if (input.dryRun) requireScope(req, "notes:read");
    const note = notes.patchContent((req.params as { id: string }).id, input);
    if ("dryRun" in note) return note;
    return canRead(req) ? notes.externalNote((req.params as { id: string }).id, "markdown") : minimalMutationResult(note);
  });
}
