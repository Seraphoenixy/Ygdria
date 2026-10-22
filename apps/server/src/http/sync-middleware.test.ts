import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { gzipSync, gunzipSync, brotliDecompressSync } from "node:zlib";
import { registerSyncCodec } from "./sync-middleware.js";
import { buildApp } from "../app.js";

const mediaType = "application/vnd.ygdria.sync+json";
const applications: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

function codecApp(limit = 1024) {
  const app = Fastify();
  applications.push(app);
  registerSyncCodec(app);
  app.post("/api/v1/sync/push", { bodyLimit: limit }, async (req) => req.body);
  app.post("/public", async () => ({ reached: true }));
  app.get("/api/v1/sync/changes", async () => ({ text: "x".repeat(2048) }));
  return app;
}

describe("sync request compression security", () => {
  it("retains gzip and identity support on the sync push route", async () => {
    const app = codecApp();
    const body = { changes: [] };
    for (const encoding of ["gzip", "identity"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers: { "content-type": mediaType, "content-encoding": encoding },
        payload: encoding === "gzip" ? gzipSync(JSON.stringify(body)) : JSON.stringify(body),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(body);
    }
  });

  it("rejects Brotli and stacked encodings without invoking their decoders", async () => {
    const app = codecApp();
    for (const encoding of ["br", "gzip, br", "deflate"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers: { "content-type": mediaType, "content-encoding": encoding },
        payload: Buffer.from("not a compressed stream"),
      });
      expect(response.statusCode).toBe(415);
    }
  });

  it("does not decode custom sync bodies on unrelated endpoints", async () => {
    const app = codecApp();
    const response = await app.inject({
      method: "POST",
      url: "/public",
      headers: { "content-type": mediaType, "content-encoding": "gzip" },
      payload: Buffer.from("not gzip"),
    });
    expect(response.statusCode).toBe(415);
  });

  it("enforces the decoded route limit during gzip expansion, including concatenated members", async () => {
    const app = codecApp(1024);
    for (const payload of [
      gzipSync("x".repeat(2048)),
      Buffer.concat([gzipSync("x".repeat(768)), gzipSync("x".repeat(768))]),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers: { "content-type": mediaType, "content-encoding": "gzip" },
        payload,
      });
      expect(response.statusCode).toBe(413);
    }
  });

  it("rejects oversized encoded bodies before processing", async () => {
    const app = codecApp(128);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sync/push",
      headers: { "content-type": mediaType },
      payload: "x".repeat(129),
    });
    expect(response.statusCode).toBe(413);
  });

  it("reports invalid gzip and invalid JSON as client errors", async () => {
    const app = codecApp();
    for (const payload of [Buffer.from("not gzip"), gzipSync("not JSON")]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sync/push",
        headers: { "content-type": mediaType, "content-encoding": "gzip" },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("keeps device authentication ahead of decoding and rejects compression on public login", async () => {
    const app = buildApp({ databaseUrl: ":memory:", enableDeviceAuth: true });
    applications.push(app);
    for (const [url, expected] of [
      ["/api/v1/sync/push", 401],
      ["/api/v1/auth/login/challenge", 415],
      ["/api/v1/devices/pair", 415],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": mediaType, "content-encoding": "gzip" },
        payload: Buffer.from("not gzip"),
      });
      expect(response.statusCode).toBe(expected);
    }
  });

  it("retains gzip and Brotli response compression", async () => {
    const app = codecApp();
    for (const encoding of ["gzip", "br"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/sync/changes",
        headers: { "accept-encoding": encoding },
      });
      expect(response.headers["content-encoding"]).toBe(encoding);
      const decoded =
        encoding === "gzip"
          ? gunzipSync(response.rawPayload)
          : brotliDecompressSync(response.rawPayload);
      expect(JSON.parse(decoded.toString())).toEqual({ text: "x".repeat(2048) });
    }
  });
});
