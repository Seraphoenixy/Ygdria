import type { FastifyInstance } from "fastify";
import type { Devices } from "@ygdria/domain";
import type { EtapiSessions } from "../security/etapi-sessions.js";
import { httpError } from "./errors.js";

export const PUBLIC_API_PATHS = new Set([
  "/api/v1/health",
  "/api/v1/ready",
  "/api/v1/auth/config",
  "/api/v1/devices/initialize",
  "/api/v1/auth/login/challenge",
  "/api/v1/auth/login/verify",
  "/api/v1/devices/pair",
]);

export function registerDeviceAuthHook(
  app: FastifyInstance,
  devices: Devices,
  etapiSessions?: EtapiSessions,
) {
  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS") return;
    const url = req.url.split("?")[0];
    // Static assets and the SPA shell are public; the API/ETAPI surface is gated.
    if (!url.startsWith("/api/") && !url.startsWith("/etapi/")) return;
    if (PUBLIC_API_PATHS.has(url)) return;
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      throw httpError(401, url.startsWith("/etapi/") ? "Missing access token" : "Missing device token");
    }
    const token = auth.slice(7);
    if (url.startsWith("/etapi/")) {
      const etapiSession = etapiSessions?.verify(token);
      if (etapiSession) {
        // Password rotation and explicit device revocation also invalidate any
        // short-lived ETAPI sessions issued by that device.
        if (
          etapiSession.issuedByDeviceId &&
          devices.isBootstrapped() &&
          !devices.get(etapiSession.issuedByDeviceId)
        ) {
          etapiSessions!.revoke(etapiSession.id);
          throw httpError(401, "Invalid access token");
        }
        req.etapiSession = etapiSession;
        return;
      }
    }
    // verify() enforces the fixed 5-day sliding idle timeout and reclaims
    // expired tokens on the spot; a rejected token yields a generic 401.
    const device = devices.verify(token);
    if (!device) {
      throw httpError(401, url.startsWith("/etapi/") ? "Invalid access token" : "Invalid device token");
    }
    req.device = device;
  });
}
