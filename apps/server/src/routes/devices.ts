import type { FastifyInstance } from "fastify";
import type { Devices } from "@ygdria/domain";
import { httpError } from "../http/errors.js";

export interface DeviceRouteDeps {
  devices: Devices;
  enableDeviceAuth: boolean;
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceRouteDeps) {
  const { devices, enableDeviceAuth } = deps;

  app.post("/api/v1/devices/pair", async (req) => {
    if (!enableDeviceAuth)
      throw httpError(403, "Device auth is not enabled on this server");
    const body = req.body as { pairingToken?: string; label?: string };
    if (!body?.pairingToken || !body?.label)
      throw httpError(400, "pairingToken and label are required");
    return devices.pair(body.pairingToken, body.label);
  });

  app.get("/api/v1/devices", async () => devices.list());

  app.get("/api/v1/devices/me", async (req) => {
    return req.device;
  });

  app.post("/api/v1/devices/pairing-token", async (req) => {
    const body = (req.body ?? {}) as { ttlMs?: number };
    return devices.createPairingToken(req.device!.id, body.ttlMs);
  });

  app.delete("/api/v1/devices/:id", async (req) => {
    const targetId = (req.params as { id: string }).id;
    devices.revoke(targetId);
    return { revoked: targetId };
  });

  app.post("/api/v1/devices/revoke-all", async (req) => {
    const revoked = devices.revokeAllExcept(req.device!.id);
    return { revoked };
  });
}