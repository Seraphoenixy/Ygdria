import type { FastifyInstance } from "fastify";
import type { MaintenanceRunner } from "../maintenance.js";
import { securityLog } from "../security/rate-limit.js";

export interface MaintenanceRouteDeps {
  maintenance: MaintenanceRunner;
}

export function registerMaintenanceRoutes(app: FastifyInstance, deps: MaintenanceRouteDeps) {
  const { maintenance } = deps;

  app.post("/api/v1/maintenance/database", async (req) => {
    const rebuildFts = String((req.query as { rebuildFts?: string }).rebuildFts ?? "") === "true";
    const result = maintenance.start(rebuildFts);
    securityLog(app, "maintenance_task_started", {
      taskId: result.id,
      rebuildFts,
      deviceId: req.device?.id,
    });
    return result;
  });

  app.post("/api/v1/maintenance/search-index", async (req) => {
    const result = maintenance.startSearchIndexRebuild();
    securityLog(app, "search_index_rebuild_started", {
      taskId: result.id,
      deviceId: req.device?.id,
    });
    return result;
  });

  app.get("/api/v1/maintenance/status", async () => {
    const status = maintenance.getStatus();
    if (!status) return { task: null };
    return { task: status };
  });
}