import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { contentType } from "../http/content-type.js";

export interface StaticRouteDeps {
  webDist: string;
}

export function registerStaticRoutes(app: FastifyInstance, deps: StaticRouteDeps) {
  const { webDist } = deps;

  if (!existsSync(webDist)) return;

  app.get("/assets/*", async (request, reply) => {
    const asset = (request.params as { "*": string })["*"];
    const file = resolve(webDist, "assets", asset);
    if (!file.startsWith(`${resolve(webDist)}${sep}`) || !existsSync(file)) {
      return reply.code(404).send({ error: { code: "NotFound", message: "Asset not found" } });
    }
    return reply.type(contentType(file)).send(readFileSync(file));
  });

  app.get("/*", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(readFileSync(resolve(webDist, "index.html"))),
  );
}