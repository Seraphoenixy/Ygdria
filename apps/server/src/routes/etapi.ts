import type { FastifyInstance } from "fastify";
import type { NoteService } from "@ygdria/domain";
import { parseExpectedVersion } from "../sync/helpers.js";

export interface EtapiRouteDeps {
  notes: NoteService;
}

export function registerEtapiRoutes(app: FastifyInstance, deps: EtapiRouteDeps) {
  const { notes } = deps;

  app.get("/etapi/notes/:id/content", async (req, reply) => {
    const f = ((req.query as { format?: string }).format ?? "markdown") as
      "markdown" | "json" | "html";
    const result = notes.content((req.params as { id: string }).id, f);
    if (f === "markdown") reply.type("text/markdown");
    if (f === "html") reply.type("text/html");
    return result;
  });

  app.put("/etapi/notes/:id/content", async (req) => {
    const type = req.headers["content-type"] ?? "";
    const expectedVersion = parseExpectedVersion(req.headers["if-match"]);
    return notes.putContent(
      (req.params as { id: string }).id,
      req.body as string,
      type.includes("application/json") ? "json" : "markdown",
      expectedVersion,
      req.headers["x-ygdria-import"] !== "1",
    );
  });
}