import type { FastifyInstance } from "fastify";
import { collectSyncMaintenanceStats, listPeerCursors, listRebaselineRequiredPeers, type SqliteDatabase } from "@ygdria/database";
import type { MaintenanceRunner } from "../maintenance.js";
import { securityLog } from "../security/rate-limit.js";
import { SYNC_PEER_MAX_INACTIVE_MS } from "@ygdria/shared";

export interface MaintenanceRouteDeps {
  maintenance: MaintenanceRunner;
  sqlite: SqliteDatabase;
}

export function registerMaintenanceRoutes(app: FastifyInstance, deps: MaintenanceRouteDeps) {
  const { maintenance, sqlite } = deps;

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

  /**
   * Read-only capacity report for the replication metadata and the durable
   * attachment cleanup queue. Answers "why is the database this size, and what
   * is holding retention open" without mutating anything.
   */
  app.get("/api/v1/maintenance/sync-status", async () => {
    const stats = collectSyncMaintenanceStats(sqlite);
    const inactiveCutoff = stats.capturedAt - SYNC_PEER_MAX_INACTIVE_MS;
    const activePeers = listPeerCursors(sqlite).map((peer) => ({
      ...peer,
      expired: peer.lastActiveAt < inactiveCutoff,
      rebaselineRequired: false,
    }));
    // Gated peers have no cursor row (it was dropped on expiry) but their gate
    // state is real and must be visible so operators know they exist.
    const gatedPeers = listRebaselineRequiredPeers(sqlite).map((peer) => ({
      peerId: peer.peerId,
      lastAdvanceId: 0,
      advancedAt: null,
      lastActiveAt: peer.since,
      expired: true,
      rebaselineRequired: true,
    }));
    return {
      stats,
      lastRun: maintenance.getLastSyncStats(),
      peers: [...activePeers, ...gatedPeers],
    };
  });
}