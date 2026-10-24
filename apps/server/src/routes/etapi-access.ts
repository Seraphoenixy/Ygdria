import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EtapiAccess } from "../security/etapi-access.js";
import { parse } from "../http/errors.js";

export function registerEtapiAccessRoutes(app: FastifyInstance, access: EtapiAccess) {
  app.get("/api/v1/etapi/access", async () => access.getState());
  app.patch("/api/v1/etapi/access", async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), req.body, req.log);
    const state = access.setEnabled(enabled);
    req.log.info({ enabled }, "External local access changed");
    return state;
  });
}
