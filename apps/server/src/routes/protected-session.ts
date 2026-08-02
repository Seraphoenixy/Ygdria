import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@ygdria/database";
import { encodeCiphertextContent } from "@ygdria/database";
import type { Devices } from "@ygdria/domain";
import { ConflictError } from "@ygdria/domain";
import { readSetting, writeSetting, deleteSetting } from "../http/settings.js";
import { securityLog } from "../security/rate-limit.js";
import { pruneExpiredReauthTokens } from "../security/srp-sessions.js";
import { httpError } from "../http/errors.js";
import {
  AUTH_PROTOCOL_VERSION,
  KDF_VERSION,
  MASTER_PASSWORD_PBKDF2_ITERATIONS,
} from "@ygdria/shared";

export interface ProtectedSessionRouteDeps {
  store: { sqlite: SqliteDatabase };
  devices: Devices;
  enableDeviceAuth: boolean;
  protectedSessionReauth: Map<string, number>;
}

export function registerProtectedSessionRoutes(app: FastifyInstance, deps: ProtectedSessionRouteDeps) {
  const { store, devices, enableDeviceAuth, protectedSessionReauth } = deps;

  app.get("/api/v1/protected-session", async () => {
    const salt =
      (
        store.sqlite
          .prepare("SELECT value FROM settings WHERE key=?")
          .get("protected_session_salt") as { value?: string } | undefined
      )?.value ?? null;
    const verifier =
      (
        store.sqlite
          .prepare("SELECT value FROM settings WHERE key=?")
          .get("protected_session_verifier") as { value?: string } | undefined
      )?.value ?? null;
    const timeoutMs = Number(
      (
        store.sqlite
          .prepare("SELECT value FROM settings WHERE key=?")
          .get("protected_session_timeout_ms") as { value?: string } | undefined
      )?.value ?? 600000,
    );
    return {
      configured: salt !== null,
      salt,
      verifier,
      timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs >= 60000 ? timeoutMs : 600000,
    };
  });

  app.post("/api/v1/protected-session/setup", async (req) => {
    const body = req.body as {
      salt: string;
      verifier: string;
      timeoutMs?: number;
      auth?: { accessSalt: string; srpSalt: string; verifier: string };
    };
    if (!body.salt || !body.verifier) throw httpError(400, "salt and verifier are required");
    if (enableDeviceAuth && !body.auth)
      throw httpError(
        400,
        "auth (new SRP record) is required when device authentication is enabled — use /devices/initialize or include auth to keep the unified master password",
      );
    if (body.auth && (!body.auth.accessSalt || !body.auth.srpSalt || !body.auth.verifier))
      throw httpError(
        400,
        "auth.accessSalt, auth.srpSalt and auth.verifier are required when auth is provided",
      );
    const t = Date.now();
    const authReplaced = Boolean(body.auth);
    store.sqlite.transaction(() => {
      writeSetting(store.sqlite, "protected_session_salt", body.salt, t);
      writeSetting(store.sqlite, "protected_session_verifier", body.verifier, t);
      if (body.timeoutMs !== undefined) {
        if (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 60000)
          throw httpError(400, "Protected session timeout must be at least one minute");
        writeSetting(store.sqlite, "protected_session_timeout_ms", String(body.timeoutMs), t);
      }
      if (body.auth) {
        writeSetting(store.sqlite, "auth_access_salt", body.auth.accessSalt, t);
        writeSetting(store.sqlite, "auth_srp_salt", body.auth.srpSalt, t);
        writeSetting(store.sqlite, "auth_srp_verifier", body.auth.verifier, t);
        writeSetting(store.sqlite, "auth_protocol_version", AUTH_PROTOCOL_VERSION, t);
        writeSetting(store.sqlite, "auth_kdf_version", KDF_VERSION, t);
        writeSetting(
          store.sqlite,
          "auth_pbkdf2_iterations",
          String(MASTER_PASSWORD_PBKDF2_ITERATIONS),
          t,
        );
      }
    })();
    if (authReplaced) devices.revokeAll();
    securityLog(app, "protected_session_setup", { authReplaced });
    return { configured: true, authReplaced };
  });

  app.post("/api/v1/protected-session/change-password", async (req) => {
    const body = req.body as {
      salt?: string;
      verifier?: string;
      timeoutMs?: number;
      notes?: Array<{ id?: string; contentCiphertext?: string; expectedVersion?: number }>;
      auth?: { accessSalt: string; srpSalt: string; verifier: string };
      reauthToken?: string;
    };
    if (!body?.salt || !body.verifier || !Array.isArray(body.notes))
      throw httpError(400, "salt, verifier, and notes are required");
    if (
      body.timeoutMs !== undefined &&
      (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 60000)
    )
      throw httpError(400, "Protected session timeout must be at least one minute");
    if (enableDeviceAuth && !body.auth)
      throw httpError(
        400,
        "auth (new SRP record) is required when device authentication is enabled — the file key and service-access credential must migrate together",
      );
    if (body.auth && (!body.auth.accessSalt || !body.auth.srpSalt || !body.auth.verifier))
      throw httpError(
        400,
        "auth.accessSalt, auth.srpSalt and auth.verifier are required when auth is provided",
      );
    if (enableDeviceAuth) {
      pruneExpiredReauthTokens(protectedSessionReauth);
      const expiresAt = body.reauthToken
        ? protectedSessionReauth.get(body.reauthToken)
        : undefined;
      if (!expiresAt || expiresAt <= Date.now())
        throw httpError(401, "Current master-password verification is required");
      protectedSessionReauth.delete(body.reauthToken!);
    }
    const noteIds = new Set<string>();
    const notes: Array<{ id: string; contentCiphertext: string; expectedVersion: number }> = [];
    for (const note of body.notes) {
      const { id, contentCiphertext, expectedVersion } = note;
      const version = Number(expectedVersion);
      if (
        !id ||
        !contentCiphertext ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        noteIds.has(id)
      )
        throw httpError(400, "Invalid protected note update");
      noteIds.add(id);
      notes.push({ id, contentCiphertext, expectedVersion: version });
    }
    const timestamp = Date.now();
    store.sqlite.transaction(() => {
      const protectedRows = store.sqlite
        .prepare("SELECT id FROM notes WHERE is_protected=1")
        .all() as Array<{ id: string }>;
      if (protectedRows.some((row) => !noteIds.has(row.id)))
        throw new ConflictError(
          "Protected notes changed elsewhere; unlock again before changing the password.",
        );
      for (const note of notes) {
        const changed = store.sqlite
          .prepare(
            "UPDATE notes SET content_data=?,content_codec=?,content_size=?,content_hash=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL AND is_protected=1",
          )
          .run(
            encodeCiphertextContent(note.contentCiphertext).data,
            "ciphertext-v1",
            Buffer.byteLength(note.contentCiphertext),
            createHash("sha256").update(note.contentCiphertext).digest("hex"),
            timestamp,
            note.id,
            note.expectedVersion,
          );
        if (changed.changes !== 1)
          throw new ConflictError(
            "Protected note changed elsewhere; unlock again before changing the password.",
          );
      }
      writeSetting(store.sqlite, "protected_session_salt", body.salt!, timestamp);
      writeSetting(store.sqlite, "protected_session_verifier", body.verifier!, timestamp);
      if (body.timeoutMs !== undefined)
        writeSetting(
          store.sqlite,
          "protected_session_timeout_ms",
          String(body.timeoutMs),
          timestamp,
        );
      if (body.auth) {
        writeSetting(store.sqlite, "auth_access_salt", body.auth.accessSalt, timestamp);
        writeSetting(store.sqlite, "auth_srp_salt", body.auth.srpSalt, timestamp);
        writeSetting(store.sqlite, "auth_srp_verifier", body.auth.verifier, timestamp);
        writeSetting(store.sqlite, "auth_protocol_version", AUTH_PROTOCOL_VERSION, timestamp);
        writeSetting(store.sqlite, "auth_kdf_version", KDF_VERSION, timestamp);
        writeSetting(
          store.sqlite,
          "auth_pbkdf2_iterations",
          String(MASTER_PASSWORD_PBKDF2_ITERATIONS),
          timestamp,
        );
      }
    })();
    if (body.auth) devices.revokeAll();
    securityLog(app, "master_password_changed", {
      changedNotes: notes.length,
      authReplaced: Boolean(body.auth),
    });
    return { configured: true, changedNotes: notes.length, authReplaced: Boolean(body.auth) };
  });

  app.post("/api/v1/protected-session/clear", async (req) => {
    const reauthToken = (req.body as { reauthToken?: string } | undefined)?.reauthToken;
    if (enableDeviceAuth) {
      pruneExpiredReauthTokens(protectedSessionReauth);
      const expiresAt = reauthToken ? protectedSessionReauth.get(reauthToken) : undefined;
      if (!expiresAt || expiresAt <= Date.now())
        throw httpError(401, "Current master-password verification is required");
      protectedSessionReauth.delete(reauthToken!);
    }
    deleteSetting(store.sqlite, "protected_session_salt");
    deleteSetting(store.sqlite, "protected_session_verifier");
    deleteSetting(store.sqlite, "protected_session_timeout_ms");
    securityLog(app, "protected_session_cleared", {});
    return { configured: false };
  });

  app.patch("/api/v1/protected-session", async (req) => {
    const body = req.body as { timeoutMs: number };
    if (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 60000)
      throw httpError(400, "Protected session timeout must be at least one minute");
    writeSetting(store.sqlite, "protected_session_timeout_ms", String(body.timeoutMs), Date.now());
    return { timeoutMs: body.timeoutMs };
  });
}