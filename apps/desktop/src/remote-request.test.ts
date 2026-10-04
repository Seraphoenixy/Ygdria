import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { readRemoteResponse } from "./remote-request.js";

describe("remote response deadline", () => {
  for (const contentType of ["application/json", "application/octet-stream"]) {
    it(`times out a stalled ${contentType} body after headers arrive`, async () => {
      const server = createServer((_, res) => {
        res.writeHead(200, { "Content-Type": contentType });
        res.flushHeaders();
        const timer = setTimeout(() => res.end("{}"), 300);
        res.on("close", () => clearTimeout(timer));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      try {
        await expect(
          readRemoteResponse(`http://127.0.0.1:${address.port}`, {}, 100),
        ).rejects.toThrow();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
