import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as srpServer from "secure-remote-password/server.js";
import type { SqliteDatabase } from "@ygdria/database";
import type { Devices } from "@ygdria/domain";
import { isAuthInitialized, readSetting, writeSetting, deleteSetting } from "../http/settings.js";
import {
  securityLog,
  recordLoginFailure,
  pruneExpiredLoginFailures,
  evictOldest,
} from "../security/rate-limit.js";
import {
  pruneExpiredSrpSessions,
  pruneExpiredReauthTokens,
} from "../security/srp-sessions.js";
import {
  httpError,
  SRP_LOGIN_TTL_MS,
  MAX_SECURITY_STATE_RECORDS,
  DEFAULT_PROTECTED_SESSION_TIMEOUT_MS,
} from "../http/errors.js";
import {
  ACCESS_SECRET_CONTEXT,
  AUTH_PROTOCOL_VERSION,
  KDF_VERSION,
  MASTER_PASSWORD_PBKDF2_ITERATIONS,
  SRP_USERNAME,
} from "@ygdria/shared";

export interface AuthRouteDeps {
  store: { sqlite: SqliteDatabase };
  devices: Devices;
  enableDeviceAuth: boolean;
  attachmentRoot: string;
  srpLoginSessions: Map<string, { serverSecretEphemeral: string; expiresAt: number }>;
  protectedSessionReauth: Map<string, number>;
  accessLoginFailures: Map<string, { failures: number; blockedUntil: number; expiresAt: number }>;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const {
    store, devices, enableDeviceAuth, attachmentRoot,
    srpLoginSessions, protectedSessionReauth, accessLoginFailures,
  } = deps;

  app.get("/api/v1/health", async () => ({
    status: "ok",
    bootstrapped: devices.isBootstrapped(),
    requiresDeviceAuth: Boolean(enableDeviceAuth),
    authInitialized: isAuthInitialized(store.sqlite),
  }));

  app.get("/api/v1/ready", async (_req, reply) => {
    let dbOk = false;
    let fsOk = false;
    try {
      store.sqlite.prepare("SELECT 1").get();
      dbOk = true;
    } catch {
      /* Database unavailable */
    }
    try {
      await mkdir(attachmentRoot, { recursive: true });
      fsOk = true;
    } catch {
      /* Attachment directory inaccessible */
    }
    if (!dbOk || !fsOk) {
      reply.code(503);
      return { status: "unavailable" };
    }
    return { status: "ok" };
  });

  app.get("/api/v1/auth/config", async () => {
    if (!enableDeviceAuth)
      throw httpError(403, "Device auth is not enabled on this server");
    const initialized = isAuthInitialized(store.sqlite);
    if (!initialized) {
      return {
        initialized: false,
        protocolVersion: AUTH_PROTOCOL_VERSION,
        kdfVersion: KDF_VERSION,
        pbkdf2Iterations: MASTER_PASSWORD_PBKDF2_ITERATIONS,
      };
    }
    return {
      initialized: true,
      protocolVersion: readSetting(store.sqlite, "auth_protocol_version") ?? AUTH_PROTOCOL_VERSION,
      kdfVersion: readSetting(store.sqlite, "auth_kdf_version") ?? KDF_VERSION,
      pbkdf2Iterations: Number(
        readSetting(store.sqlite, "auth_pbkdf2_iterations") ??
          String(MASTER_PASSWORD_PBKDF2_ITERATIONS),
      ),
      accessSalt: readSetting(store.sqlite, "auth_access_salt"),
      srpSalt: readSetting(store.sqlite, "auth_srp_salt"),
      accessSecretContext: ACCESS_SECRET_CONTEXT,
      srpUsername: SRP_USERNAME,
    };
  });

  app.post("/api/v1/devices/initialize", async (req) => {
    if (!enableDeviceAuth)
      throw httpError(403, "Device auth is not enabled on this server");
    const body = (req.body ?? {}) as {
      accessSalt?: string;
      srpSalt?: string;
      verifier?: string;
      fileSalt?: string;
      fileVerifier?: string;
      label?: string;
    };
    if (!body.accessSalt || !body.srpSalt || !body.verifier || !body.label?.trim())
      throw httpError(400, "accessSalt, srpSalt, verifier and label are required");
    if (!body.fileSalt || !body.fileVerifier)
      throw httpError(400, "fileSalt and fileVerifier are required (unified master-password init)");
    const timestamp = Date.now();
    store.sqlite.transaction(() => {
      if (isAuthInitialized(store.sqlite))
        throw httpError(409, "Master password is already configured");
      writeSetting(store.sqlite, "auth_access_salt", body.accessSalt!, timestamp);
      writeSetting(store.sqlite, "auth_srp_salt", body.srpSalt!, timestamp);
      writeSetting(store.sqlite, "auth_srp_verifier", body.verifier!, timestamp);
      writeSetting(store.sqlite, "auth_protocol_version", AUTH_PROTOCOL_VERSION, timestamp);
      writeSetting(store.sqlite, "auth_kdf_version", KDF_VERSION, timestamp);
      writeSetting(
        store.sqlite,
        "auth_pbkdf2_iterations",
        String(MASTER_PASSWORD_PBKDF2_ITERATIONS),
        timestamp,
      );
      writeSetting(store.sqlite, "auth_access_secret_context", ACCESS_SECRET_CONTEXT, timestamp);
      writeSetting(store.sqlite, "auth_srp_username", SRP_USERNAME, timestamp);
      writeSetting(store.sqlite, "protected_session_salt", body.fileSalt!, timestamp);
      writeSetting(store.sqlite, "protected_session_verifier", body.fileVerifier!, timestamp);
      writeSetting(
        store.sqlite,
        "protected_session_timeout_ms",
        String(DEFAULT_PROTECTED_SESSION_TIMEOUT_MS),
        timestamp,
      );
      deleteSetting(store.sqlite, "server_access_password_salt");
      deleteSetting(store.sqlite, "server_access_password_hash");
    })();
    securityLog(app, "device_initialized", { label: body.label.trim() });
    return devices.issueDevice(body.label);
  });

  app.post("/api/v1/auth/login/challenge", async (req) => {
    if (!enableDeviceAuth)
      throw httpError(403, "Device auth is not enabled on this server");
    const body = (req.body ?? {}) as { clientPublicEphemeral?: string };
    if (!body.clientPublicEphemeral) throw httpError(400, "clientPublicEphemeral is required");
    pruneExpiredLoginFailures(accessLoginFailures);
    const attempt = accessLoginFailures.get(req.ip ?? "unknown");
    if (attempt && attempt.blockedUntil > Date.now())
      throw httpError(429, "Too many failed login attempts; try again later");
    pruneExpiredSrpSessions(srpLoginSessions);
    if (!isAuthInitialized(store.sqlite)) throw httpError(401, "Authentication failed");
    const verifier = readSetting(store.sqlite, "auth_srp_verifier")!;
    const srpSalt = readSetting(store.sqlite, "auth_srp_salt")!;
    let serverEphemeral: { secret: string; public: string };
    try {
      serverEphemeral = srpServer.generateEphemeral(verifier);
    } catch {
      recordLoginFailure(accessLoginFailures, req.ip);
      throw httpError(401, "Authentication failed");
    }
    const challengeId = randomBytes(32).toString("base64url");
    evictOldest(srpLoginSessions, MAX_SECURITY_STATE_RECORDS);
    srpLoginSessions.set(challengeId, {
      serverSecretEphemeral: serverEphemeral.secret,
      expiresAt: Date.now() + SRP_LOGIN_TTL_MS,
    });
    return { challengeId, srpSalt, serverPublicEphemeral: serverEphemeral.public };
  });

  app.post("/api/v1/auth/login/verify", async (req) => {
    if (!enableDeviceAuth)
      throw httpError(403, "Device auth is not enabled on this server");
    const body = (req.body ?? {}) as {
      challengeId?: string;
      clientPublicEphemeral?: string;
      clientSessionProof?: string;
      label?: string;
    };
    if (
      !body.challengeId ||
      !body.clientPublicEphemeral ||
      !body.clientSessionProof ||
      !body.label?.trim()
    )
      throw httpError(
        400,
        "challengeId, clientPublicEphemeral, clientSessionProof and label are required",
      );
    pruneExpiredLoginFailures(accessLoginFailures);
    const attempt = accessLoginFailures.get(req.ip ?? "unknown");
    if (attempt && attempt.blockedUntil > Date.now())
      throw httpError(429, "Too many failed login attempts; try again later");
    const session = srpLoginSessions.get(body.challengeId);
    srpLoginSessions.delete(body.challengeId);
    if (!session || session.expiresAt <= Date.now()) {
      recordLoginFailure(accessLoginFailures, req.ip);
      throw httpError(401, "Authentication failed");
    }
    const verifier = readSetting(store.sqlite, "auth_srp_verifier");
    const srpSalt = readSetting(store.sqlite, "auth_srp_salt");
    if (!verifier || !srpSalt) {
      recordLoginFailure(accessLoginFailures, req.ip);
      throw httpError(401, "Authentication failed");
    }
    let serverSession: { key: string; proof: string };
    try {
      serverSession = srpServer.deriveSession(
        session.serverSecretEphemeral,
        body.clientPublicEphemeral,
        srpSalt,
        SRP_USERNAME,
        verifier,
        body.clientSessionProof,
      );
    } catch {
      recordLoginFailure(accessLoginFailures, req.ip);
      throw httpError(401, "Authentication failed");
    }
    accessLoginFailures.delete(req.ip ?? "unknown");
    const credential = devices.issueDevice(body.label);
    pruneExpiredReauthTokens(protectedSessionReauth);
    evictOldest(protectedSessionReauth, MAX_SECURITY_STATE_RECORDS);
    const reauthToken = randomBytes(32).toString("base64url");
    protectedSessionReauth.set(reauthToken, Date.now() + 5 * 60 * 1000);
    securityLog(app, "login_success", { deviceId: credential.deviceId, label: body.label.trim() });
    return {
      deviceId: credential.deviceId,
      deviceToken: credential.deviceToken,
      serverSessionProof: serverSession.proof,
      reauthToken,
    };
  });
}