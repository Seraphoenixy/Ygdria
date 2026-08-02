import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AttachmentService } from "@ygdria/domain";
import { NotFoundError } from "@ygdria/domain";
import type { SqliteDatabase } from "@ygdria/database";
import {
  httpError,
  MAX_ATTACHMENT_BYTES,
} from "../http/errors.js";
import { mediaType } from "../http/content-type.js";

export interface AttachmentRouteDeps {
  attachments: AttachmentService;
  sqlite: SqliteDatabase;
  attachmentRoot: string;
  recordOutbound: (req: { headers: Record<string, string | string[] | undefined> }) => boolean;
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps) {
  const { attachments, sqlite, attachmentRoot, recordOutbound } = deps;

  app.get("/api/v1/attachments", async () => ({
    attachments: attachments.listAttachments(),
    unusedCount: attachments.countUnusedAttachments(),
  }));

  app.get("/api/v1/attachments/unused/count", async () => ({
    count: attachments.countUnusedAttachments(),
  }));

  app.delete("/api/v1/attachments/unused", async (req) => {
    const before = Number((req.query as { before?: string }).before);
    const result = attachments.clearUnusedAttachments(
      Number.isSafeInteger(before) && before >= 0 ? before : undefined,
    );
    await attachments.cleanOrphanFiles();
    return result;
  });

  app.get("/api/v1/attachments/:id", async (req, reply) => {
    const attachment = attachments.attachment((req.params as { id: string }).id);
    const file = resolve(attachmentRoot, attachment.storageKey.replace(/^attachments\//, ""));
    if (!existsSync(file)) throw new NotFoundError("Attachment file not found");
    reply.type(attachment.mimeType);
    if (!attachment.mimeType.startsWith("image/"))
      reply.header("content-disposition", "attachment");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-length", attachment.size);
    return reply.send(createReadStream(file));
  });

  app.get("/api/v1/attachments/by-hash/:hash/exists", async (req) => {
    const hash = (req.params as { hash: string }).hash;
    const row = sqlite
      .prepare("SELECT id FROM attachments WHERE content_hash=? LIMIT 1")
      .get(hash) as { id: string } | undefined;
    return { exists: Boolean(row), id: row?.id ?? null };
  });

  app.get("/api/v1/attachments/by-hash/:hash", async (req, reply) => {
    const hash = (req.params as { hash: string }).hash;
    const row = sqlite
      .prepare(
        "SELECT id,filename,mime_type mimeType,size,storage_key storageKey FROM attachments WHERE content_hash=? LIMIT 1",
      )
      .get(hash) as
      | { id: string; filename: string; mimeType: string; size: number; storageKey: string }
      | undefined;
    if (!row) throw new NotFoundError("Attachment not found by hash");
    const file = resolve(attachmentRoot, row.storageKey.replace(/^attachments\//, ""));
    if (!existsSync(file)) throw new NotFoundError("Attachment file not found");
    reply.type(row.mimeType);
    if (!row.mimeType.startsWith("image/")) reply.header("content-disposition", "attachment");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-length", row.size);
    return reply.send(createReadStream(file));
  });

  app.post("/api/v1/attachments/by-hash/:hash", async (req, reply) => {
    const hash = (req.params as { hash: string }).hash;
    const query = req.query as { noteId?: string; filename?: string; attachmentId?: string };
    const noteId = query.noteId;
    const filename = query.filename;
    if (!hash || !noteId || !filename)
      throw httpError(400, "hash, noteId, and filename are required");
    if (query.attachmentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.attachmentId))
      throw httpError(400, "attachmentId must be a UUID");
    attachments.assertUploadAllowed(noteId);
    const existing = sqlite
      .prepare(
        "SELECT id,filename,mime_type mimeType,size,storage_key storageKey,content_hash contentHash,created_at createdAt FROM attachments WHERE content_hash=? LIMIT 1",
      )
      .get(hash) as
      | {
          id: string;
          filename: string;
          mimeType: string;
          size: number;
          storageKey: string;
          contentHash: string;
          createdAt: number;
        }
      | undefined;
    if (existing && (!query.attachmentId || query.attachmentId === existing.id)) {
      // Older versions classified SVGs with XML comments/DOCTYPE as opaque
      // files. A hash hit would otherwise preserve that stale MIME type
      // forever, including when the user imports the same archive again.
      const existingFile = resolve(attachmentRoot, existing.storageKey.replace(/^attachments\//, ""));
      if (existsSync(existingFile)) {
        const detectedMimeType = await mediaType(existingFile);
        if (detectedMimeType !== existing.mimeType) {
          sqlite.prepare("UPDATE attachments SET mime_type=? WHERE id=?").run(detectedMimeType, existing.id);
          existing.mimeType = detectedMimeType;
        }
      }
      req.log.info({ attachmentDeduplicated: true, contentHash: hash }, "reused synced attachment");
      reply.code(200);
      return {
        ...existing,
        url: `/api/v1/attachments/${existing.id}`,
        createdAt: new Date(existing.createdAt).toISOString(),
        existed: true,
      };
    }
    const ext = extname(filename);
    const tempFile = join(tmpdir(), `ygdria-sync-${randomUUID()}${ext}`);
    const hashCtx = createHash("sha256");
    let bytesWritten = 0;
    const tempStream = createWriteStream(tempFile);
    const hashStream = new Transform({
      transform(chunk, _encoding, callback) {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_ATTACHMENT_BYTES) {
          callback(httpError(413, "Attachment exceeds maximum size"));
          return;
        }
        hashCtx.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req.raw, hashStream, tempStream);
    } catch (err) {
      await unlink(tempFile).catch(() => {});
      throw err;
    }
    const computedHash = `sha256:${hashCtx.digest("hex")}`;
    if (computedHash !== hash) {
      await unlink(tempFile).catch(() => {});
      throw httpError(400, `Content hash mismatch: expected ${hash}, got ${computedHash}`);
    }
    const attachment = await attachments.addAttachment({
      noteId,
      attachmentId: query.attachmentId,
      filename,
      tempFilePath: tempFile,
      maxSizeBytes: MAX_ATTACHMENT_BYTES,
      recordSyncChange: !recordOutbound(req),
    });
    req.log.info({ attachmentDeduplicated: false, contentHash: hash, bytes: attachment.size }, "stored synced attachment");
    reply.code(201);
    return { ...attachment, url: `/api/v1/attachments/${attachment.id}`, existed: false };
  });
}
