import type { FastifyInstance } from "fastify";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { httpError } from "./errors.js";

export function registerSyncCodec(app: FastifyInstance) {
  app.addContentTypeParser("application/vnd.ygdria.sync+json", { parseAs: "buffer" }, (req, body, done) => {
    try {
      const bytes = Buffer.from(body as Buffer);
      const decoded = req.headers["content-encoding"] === "gzip"
        ? gunzipSync(bytes)
        : req.headers["content-encoding"] === "br"
          ? brotliDecompressSync(bytes)
          : bytes;
      if (decoded.byteLength > 16 * 1024 * 1024) throw httpError(413, "sync push payload exceeds 16 MiB");
      done(null, JSON.parse(decoded.toString("utf8")));
    } catch (error) { done(error as Error); }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.url.startsWith("/api/v1/sync/") || typeof payload !== "string" || payload.length < 1024) return payload;
    const accepted = req.headers["accept-encoding"] ?? "";
    if (accepted.includes("br")) {
      const compressed = brotliCompressSync(Buffer.from(payload));
      reply.header("Content-Encoding", "br").header("Vary", "Accept-Encoding");
      req.log.info({ syncCompression: "br", uncompressedBytes: Buffer.byteLength(payload), compressedBytes: compressed.byteLength }, "compressed sync response");
      return compressed;
    }
    if (accepted.includes("gzip")) {
      const compressed = gzipSync(Buffer.from(payload));
      reply.header("Content-Encoding", "gzip").header("Vary", "Accept-Encoding");
      req.log.info({ syncCompression: "gzip", uncompressedBytes: Buffer.byteLength(payload), compressedBytes: compressed.byteLength }, "compressed sync response");
      return compressed;
    }
    return payload;
  });
}