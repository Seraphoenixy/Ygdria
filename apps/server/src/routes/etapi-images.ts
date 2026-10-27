import type { FastifyInstance } from "fastify";
import type { AttachmentService, NoteService } from "@ygdria/domain";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ALLOWED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_BYTES, httpError } from "../http/errors.js";
import { mediaType } from "../http/content-type.js";

const maxBase64Length = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
const imageSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f]+$/),
  dataBase64: z.string().min(4).max(maxBase64Length)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

/** Uses the same local-access hook as every ETAPI route, never desktop credentials. */
export function registerEtapiImageRoutes(
  app: FastifyInstance,
  deps: { notes: NoteService; attachments: AttachmentService },
) {
  app.post("/etapi/notes/:id/images", { bodyLimit: maxBase64Length + 4096 }, async (req, reply) => {
    const parsed = imageSchema.safeParse(req.body);
    if (!parsed.success) throw httpError(400, "Expected a filename and canonical Base64 image bytes (maximum 20 MiB)");
    const input = parsed.data;
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw httpError(413, "Image exceeds maximum size");
    if (!bytes.length || bytes.toString("base64") !== input.dataBase64)
      throw httpError(400, "Invalid Base64 image bytes");
    const noteId = (req.params as { id: string }).id;
    // Apply external-note visibility rules before accepting or materializing bytes.
    deps.notes.externalNote(noteId, "markdown");
    deps.attachments.assertUploadAllowed(noteId);
    const tempFile = join(tmpdir(), `ygdria-etapi-image-${randomUUID()}`);
    try {
      await writeFile(tempFile, bytes, { flag: "wx", mode: 0o600 });
      const mimeType = await mediaType(tempFile);
      if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType))
        throw httpError(415, "Unsupported image content");
      const attachment = await deps.attachments.addAttachment({
        noteId,
        filename: input.filename,
        tempFilePath: tempFile,
        maxSizeBytes: MAX_ATTACHMENT_BYTES,
        allowedMimeTypes: ALLOWED_ATTACHMENT_MIME_TYPES,
      });
      const url = `/api/v1/attachments/${attachment.id}`;
      reply.code(200);
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        contentHash: attachment.contentHash,
        url,
        markdown: `![${input.filename.replace(/[\\[\]]/g, "\\$&")}](${url})`,
      };
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  });
}
