import type { FastifyInstance, FastifyRequest } from "fastify";
import { brotliCompress, gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { httpError } from "./errors.js";

const MAX_SYNC_BYTES = 16 * 1024 * 1024;
const decompressGzip = promisify(gunzip);
const compressGzip = promisify(gzip);
const compressBrotli = promisify(brotliCompress);

export function registerSyncCodec(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/vnd.ygdria.sync+json",
    {
      parseAs: "buffer",
      bodyLimit: MAX_SYNC_BYTES,
    },
    async (req: FastifyRequest, body: Buffer) => {
      // The bundled clients only send gzip to sync/push. Never decode a custom
      // sync body on a public login/pairing endpoint or an unrelated API route.
      if (req.method !== "POST" || req.routeOptions.url !== "/api/v1/sync/push") {
        throw httpError(415, "Sync content type is only supported by sync push");
      }
      const encoding = (req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (encoding !== "gzip" && encoding !== "identity") {
        throw httpError(415, "Sync requests support gzip or identity encoding only");
      }
      const limit = Math.min(MAX_SYNC_BYTES, req.routeOptions.bodyLimit ?? MAX_SYNC_BYTES);
      const bytes = Buffer.from(body as Buffer);
      let decoded: Buffer;
      try {
        decoded =
          encoding === "gzip" ? await decompressGzip(bytes, { maxOutputLength: limit }) : bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw httpError(413, "Sync payload exceeds the decoded size limit");
        }
        throw httpError(400, "Invalid gzip sync payload");
      }
      if (decoded.byteLength > limit)
        throw httpError(413, "Sync payload exceeds the decoded size limit");
      try {
        return JSON.parse(decoded.toString("utf8"));
      } catch {
        throw httpError(400, "Invalid sync JSON payload");
      }
    },
  );

  app.addHook("onSend", async (req, reply, payload) => {
    if (
      !req.url.startsWith("/api/v1/sync/") ||
      typeof payload !== "string" ||
      payload.length < 1024
    )
      return payload;
    const accepted = req.headers["accept-encoding"] ?? "";
    if (accepted.includes("br")) {
      const compressed = await compressBrotli(Buffer.from(payload));
      reply.header("Content-Encoding", "br").header("Vary", "Accept-Encoding");
      req.log.info(
        {
          syncCompression: "br",
          uncompressedBytes: Buffer.byteLength(payload),
          compressedBytes: compressed.byteLength,
        },
        "compressed sync response",
      );
      return compressed;
    }
    if (accepted.includes("gzip")) {
      const compressed = await compressGzip(Buffer.from(payload));
      reply.header("Content-Encoding", "gzip").header("Vary", "Accept-Encoding");
      req.log.info(
        {
          syncCompression: "gzip",
          uncompressedBytes: Buffer.byteLength(payload),
          compressedBytes: compressed.byteLength,
        },
        "compressed sync response",
      );
      return compressed;
    }
    return payload;
  });
}
