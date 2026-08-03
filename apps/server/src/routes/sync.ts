import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import {
  getCoalescedChangesSince,
  getChangesSince,
  hasChangesAfter,
  getMaxChangeId,
  advanceCursor,
  getCursor,
  pruneChangeLog,
  type SqliteDatabase,
} from "@ygdria/database";
import { NotFoundError } from "@ygdria/domain";
import { validPeerId, cursorKey } from "../security/srp-sessions.js";
import { httpError } from "../http/errors.js";
import {
  resolveChangeEntities,
  fullSnapshotChanges,
  rebuildSyncBaseline,
  applySyncChanges,
  type SyncEntityChange,
} from "../sync/helpers.js";

export interface SyncRouteDeps {
  sqlite: SqliteDatabase;
  attachmentRoot: string;
  /** Whether to record outbound sync changes for writes from this peer. */
  recordOutbound: (req: { headers: Record<string, string | string[] | undefined> }) => boolean;
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps) {
  const { sqlite, attachmentRoot, recordOutbound } = deps;

  /**
   * Incremental sync: return all changes since the given cursorId.
   * The response includes entity metadata only (no attachment binary data).
   * Use /api/v1/attachments/by-hash/:hash for binary content.
   */
  app.get("/api/v1/sync/changes", async (req) => {
    const query = req.query as { cursor?: string; limit?: string; maxBytes?: string; metadataOnly?: string };
    const cursorId = Number(query.cursor ?? 0);
    if (!Number.isSafeInteger(cursorId) || cursorId < 0) throw httpError(400, "cursor must be a non-negative integer");
    const requestedLimit = Number(query.limit ?? 200);
    const requestedMaxBytes = Number(query.maxBytes ?? 4 * 1024 * 1024);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;
    const maxBytes = Number.isSafeInteger(requestedMaxBytes)
      ? Math.min(Math.max(requestedMaxBytes, 64 * 1024), 16 * 1024 * 1024)
      : 4 * 1024 * 1024;
    const pending = getCoalescedChangesSince(sqlite, cursorId, limit);
    const resolved = await resolveChangeEntities(sqlite, attachmentRoot, pending, query.metadataOnly !== "1");
    const maxChangeId = getMaxChangeId(sqlite);
    const coalescedChanges = Math.max(0, getChangesSince(sqlite, cursorId, 5000).filter((change) => change.id <= (pending.at(-1)?.id ?? cursorId)).length - pending.length);
    const makeResponse = (changes: typeof resolved) => {
      const cursor = changes.length > 0 ? changes[changes.length - 1].changeId : cursorId;
      const response = {
        cursor,
        hasMore: hasChangesAfter(sqlite, cursor),
        changes,
        maxChangeId,
        stats: { serializedBytes: 0, returnedEntities: changes.length, coalescedChanges },
      };
      for (let index = 0; index < 3; index += 1)
        response.stats.serializedBytes = Buffer.byteLength(JSON.stringify(response));
      return response;
    };
    const entityChanges: typeof resolved = [];
    for (const change of resolved) {
      const candidate = [...entityChanges, change];
      if (entityChanges.length > 0 && makeResponse(candidate).stats.serializedBytes > maxBytes) break;
      entityChanges.push(change);
    }
    const response = makeResponse(entityChanges);
    req.log.info({ syncBatch: "pull", entities: entityChanges.length, serializedBytes: response.stats.serializedBytes, coalescedChanges, cursor: response.cursor }, "prepared sync batch");
    return response;
  });

  /** A full-state fallback for a new local database. Unlike the incremental
   * change log, this remains available after old log rows are pruned. */
  app.get("/api/v1/sync/snapshot", async (req) => {
    const query = req.query as { cursor?: string; limit?: string; metadataOnly?: string };
    const cursor = Number(query.cursor ?? 0);
    const requestedLimit = Number(query.limit ?? 200);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw httpError(400, "cursor must be a non-negative integer");
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;
    const all = fullSnapshotChanges(sqlite);
    const page = all.slice(cursor, cursor + limit);
    const changes = await resolveChangeEntities(sqlite, attachmentRoot, page, query.metadataOnly !== "1");
    return { cursor: cursor + page.length, hasMore: cursor + page.length < all.length, changes, maxChangeId: getMaxChangeId(sqlite) };
  });

  app.get("/api/v1/sync/notes/:id/content", async (req) => {
    const { id } = req.params as { id: string };
    const hash = (req.query as { hash?: string }).hash;
    const row = sqlite.prepare("SELECT content_data contentData,content_codec contentCodec,content_size contentSize,content_hash contentHash,plain_text plainText FROM notes WHERE id=?").get(id) as { contentData: Buffer; contentCodec: string; contentSize: number; contentHash: string; plainText: string } | undefined;
    if (!row || (hash && row.contentHash !== hash)) throw new NotFoundError("Note content version not found");
    return { ...row, contentData: Buffer.from(row.contentData).toString("base64") };
  });

  app.get("/api/v1/sync/notes/:id/content/blob", async (req, reply) => {
    const { id } = req.params as { id: string };
    const hash = (req.query as { hash?: string }).hash;
    const row = sqlite
      .prepare("SELECT content_data contentData,content_codec contentCodec,content_size contentSize,content_hash contentHash FROM notes WHERE id=?")
      .get(id) as { contentData: Buffer; contentCodec: string; contentSize: number; contentHash: string } | undefined;
    if (!row || (hash && row.contentHash !== hash)) throw new NotFoundError("Note content version not found");
    const total = row.contentData.byteLength;
    let start = 0;
    let end = Math.max(0, total - 1);
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
        reply.header("Content-Range", `bytes */${total}`);
        return reply.code(416).send();
      }
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${total}`);
    }
    reply
      .type("application/octet-stream")
      .header("Accept-Ranges", "bytes")
      .header("ETag", `"${row.contentHash}"`)
      .header("X-Content-Codec", row.contentCodec)
      .header("X-Content-Size", row.contentSize)
      .header("X-Content-Hash", row.contentHash)
      .header("Content-Length", total === 0 ? 0 : end - start + 1);
    return row.contentData.subarray(start, end + 1);
  });

  /**
   * Advance a peer's sync cursor. After the client has confirmed it has
   * downloaded all attachments referenced by changes up to cursorId, it
   * calls this to advance the cursor. On interruption, the client can
   * restart from the last advanced cursor.
   */
  app.post("/api/v1/sync/advance", async (req) => {
    const body = req.body as { peerId?: string; cursor?: number };
    const cursor = Number(body.cursor ?? NaN);
    if (!validPeerId(body.peerId) || !Number.isSafeInteger(cursor) || cursor < 0)
      throw httpError(400, "peerId and cursor (non-negative integer) are required");
    const result = advanceCursor(sqlite, cursorKey(req.device?.id, body.peerId), cursor);
    pruneChangeLog(sqlite);
    return { ...result, peerId: body.peerId };
  });

  /** Get a peer's cursor state. */
  app.get("/api/v1/sync/cursor", async (req) => {
    const peerId = (req.query as { peerId?: string }).peerId;
    if (!validPeerId(peerId)) throw httpError(400, "peerId is required");
    const cursor = getCursor(sqlite, cursorKey(req.device?.id, peerId));
    return cursor ? { ...cursor, peerId } : { peerId, lastAdvanceId: 0, advancedAt: null };
  });

  /**
   * Re-record current state for a newly initialized peer. This is needed when
   * a user migrates to a blank server at an address that previously had sync
   * cursors: the old incremental log may already have been pruned.
   */
  app.post("/api/v1/sync/rebuild", async () => rebuildSyncBaseline(sqlite));

  /** Apply a peer's metadata changes using last-write-wins timestamps. Binary
   * attachments are deliberately transferred separately by hash. */
  app.post("/api/v1/sync/push", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const body = req.body as { changes?: SyncEntityChange[] };
    if (!Array.isArray(body?.changes) || body.changes.length > 500)
      throw httpError(400, "changes must contain at most 500 entries");
    if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024)
      throw httpError(413, "sync push payload exceeds 16 MiB");
    const serializedBytes = Buffer.byteLength(JSON.stringify(body));
    const { applied, rejected } = applySyncChanges(sqlite, body.changes, recordOutbound(req));
    req.log.info({ syncBatch: "push", entities: body.changes.length, serializedBytes, applied, rejected: rejected.length }, "applied sync batch");
    return { applied, rejected };
  });
}