import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EtapiSessions } from "../security/etapi-sessions.js";
import {
  DEFAULT_ETAPI_SESSION_TTL_SECONDS,
  ETAPI_SCOPES,
  MAX_ETAPI_SESSION_TTL_SECONDS,
} from "../security/etapi-sessions.js";
import { httpError, parse } from "../http/errors.js";

const createSessionSchema = z.object({
  label: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(ETAPI_SCOPES)).min(1).max(ETAPI_SCOPES.length),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(MAX_ETAPI_SESSION_TTL_SECONDS)
    .default(DEFAULT_ETAPI_SESSION_TTL_SECONDS),
});

export function registerEtapiSessionRoutes(
  app: FastifyInstance,
  deps: { sessions: EtapiSessions },
) {
  const { sessions } = deps;

  app.post("/api/v1/etapi/sessions", async (req, reply) => {
    const input = parse(createSessionSchema, req.body, req.log);
    const result = sessions.issue({
      ...input,
      issuedByDeviceId: req.device?.id ?? null,
    });
    req.log.info(
      { etapiSessionId: result.id, scopes: result.scopes, expiresAt: result.expiresAt },
      "ETAPI session issued",
    );
    reply.code(201);
    return result;
  });

  app.get("/api/v1/etapi/sessions", async () => {
    return { sessions: sessions.list() };
  });

  app.delete("/api/v1/etapi/sessions/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    if (!sessions.revoke(id)) throw httpError(404, "ETAPI session not found");
    req.log.info({ etapiSessionId: id }, "ETAPI session revoked");
    return { revoked: id };
  });
}
