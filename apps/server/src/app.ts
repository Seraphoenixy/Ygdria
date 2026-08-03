import Fastify, { type FastifyInstance } from "fastify";

// Module augmentation: declare the `device` property on FastifyRequest so
// all route handlers get type-safe access without `as any` casts. This must
// be in the same file that's imported by consumers (including the desktop app).
declare module "fastify" {
  interface FastifyRequest {
    device?: {
      id: string;
      label: string;
      createdAt: number;
      lastActiveAt: number | null;
    };
  }
}

import cors from "@fastify/cors";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyMigrations,
  createDatabase,
} from "@ygdria/database";
import {
  AttachmentService,
  NoteService,
  Devices,
} from "@ygdria/domain";
import { MaintenanceRunner } from "./maintenance.js";
import { isPulledRemoteWrite } from "./http/errors.js";
import { registerDeviceAuthHook } from "./http/auth-hook.js";
import { registerErrorHandler } from "./http/error-handler.js";
import { createAttachmentStorage } from "./http/attachment-storage.js";
import { registerSyncCodec } from "./http/sync-middleware.js";
import { registerSecurityHeaders, registerLocalTokenHook } from "./http/security-middleware.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerProtectedSessionRoutes } from "./routes/protected-session.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerRelationRoutes } from "./routes/relations.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerEtapiRoutes } from "./routes/etapi.js";
import { registerStaticRoutes } from "./routes/static.js";

export function buildApp(
  options: {
    databaseUrl?: string;
    origin?: string;
    localToken?: string;
    webDist?: string;
    trustedProxy?: string | string[];
    /** Enable device-credential authentication for standalone server deployments. */
    enableDeviceAuth?: boolean;
  } = {},
) {
  const store = createDatabase(options.databaseUrl);
  applyMigrations(store.sqlite);
  const app = Fastify({
    logger: true,
    bodyLimit: 128 * 1024 * 1024,
    requestTimeout: 120_000,
    keepAliveTimeout: 10_000,
    connectionTimeout: 30_000,
    trustProxy: options.trustedProxy ?? false,
  });

  // --- Services & state ---
  const loginRequestCounts = new Map<string, { count: number; resetAt: number }>();
  const notes = new NoteService(store);
  const devices = new Devices();
  const srpLoginSessions = new Map<string, { serverSecretEphemeral: string; expiresAt: number }>();
  const protectedSessionReauth = new Map<string, number>();
  const accessLoginFailures = new Map<
    string,
    { failures: number; blockedUntil: number; expiresAt: number }
  >();
  const inMemoryDatabase = options.databaseUrl === ":memory:";
  const { adapter: attachmentStorage, root: attachmentRoot } = createAttachmentStorage(
    inMemoryDatabase,
    options.databaseUrl,
  );
  const attachments = new AttachmentService(store, attachmentStorage);
  const maintenance = new MaintenanceRunner(options.databaseUrl ?? "ygdria.db", store.sqlite);
  const origin = options.origin ?? "http://localhost:5173";
  const webDist = options.webDist ?? resolve(import.meta.dirname, "../../web/dist");
  const allowedOrigins = new Set([origin]);
  if (options.enableDeviceAuth) {
    // Capacitor uses fixed WebView origins. Device authentication still
    // protects every private endpoint with a bearer credential.
    allowedOrigins.add("https://localhost");
    allowedOrigins.add("capacitor://localhost");
  } else {
    allowedOrigins.add("http://localhost:5173");
    allowedOrigins.add("http://127.0.0.1:5173");
  }

  // --- Middleware ---
  registerSyncCodec(app);
  registerSecurityHeaders(app, loginRequestCounts);
  registerLocalTokenHook(app, options.localToken);

  // --- Content type parsers ---
  app.addContentTypeParser(
    ["text/markdown", "text/plain"],
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser("application/octet-stream", (_request, _payload, done) =>
    done(null, undefined),
  );

  // --- CORS ---
  app.register(cors, {
    origin: (value: string | undefined, cb: (error: Error | null, origin: boolean) => void) =>
      cb(null, !value || allowedOrigins.has(value)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Content-Encoding",
      "If-Match",
      "Authorization",
      "X-Ygdria-Device",
      "X-Ygdria-Import",
      "X-Ygdria-Local-Token",
      "X-Ygdria-Sync-Origin",
    ],
  });

  // --- Device auth ---
  if (options.enableDeviceAuth) {
    registerDeviceAuthHook(app, devices);
  }

  const pulledRemoteWrite = (req: { headers: Record<string, string | string[] | undefined> }) =>
    isPulledRemoteWrite(req, options.localToken);

  // --- Routes ---
  registerAuthRoutes(app, {
    store,
    devices,
    enableDeviceAuth: Boolean(options.enableDeviceAuth),
    attachmentRoot,
    srpLoginSessions,
    protectedSessionReauth,
    accessLoginFailures,
  });
  registerDeviceRoutes(app, {
    devices,
    enableDeviceAuth: Boolean(options.enableDeviceAuth),
  });
  registerNoteRoutes(app, { notes, sqlite: store.sqlite });
  registerProtectedSessionRoutes(app, {
    store,
    devices,
    enableDeviceAuth: Boolean(options.enableDeviceAuth),
    protectedSessionReauth,
  });
  registerSyncRoutes(app, {
    sqlite: store.sqlite,
    attachmentRoot,
    recordOutbound: (req) => !pulledRemoteWrite(req),
  });
  registerAttachmentRoutes(app, {
    attachments,
    sqlite: store.sqlite,
    attachmentRoot,
    recordOutbound: (req) => pulledRemoteWrite(req),
  });
  registerMaintenanceRoutes(app, { maintenance });
  registerEtapiRoutes(app, { notes });
  registerRelationRoutes(app, { sqlite: store.sqlite });
  registerStaticRoutes(app, { webDist });

  // --- Error handling & shutdown ---
  registerErrorHandler(app);
  app.addHook("onClose", async () => {
    try {
      store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      app.log.warn({ err: error }, "could not truncate SQLite WAL during shutdown");
    } finally {
      store.sqlite.close();
      if (inMemoryDatabase && existsSync(attachmentRoot))
        rmSync(attachmentRoot, { recursive: true, force: true });
    }
  });
  return app;
}
