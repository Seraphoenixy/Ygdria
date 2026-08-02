import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import * as srpClient from "secure-remote-password/client.js";
import * as srpServer from "secure-remote-password/server.js";
import {
  ACCESS_SECRET_CONTEXT,
  MASTER_PASSWORD_PBKDF2_ITERATIONS,
  SRP_USERNAME,
} from "@ygdria/shared";
import { buildApp } from "./app.js";

const MASTER_PASSWORD = "correct horse battery staple";
const buildDeviceApp = () =>
  buildApp({ databaseUrl: ":memory:", enableDeviceAuth: true, prettyLogs: false });

/** Node mirror of the browser's accessSecret derivation: PBKDF2-SHA256 over
 *  (masterPassword || ACCESS_SECRET_CONTEXT) with accessSalt, base64url-encoded. */
function deriveAccessSecret(password: string, accessSaltB64: string): string {
  const salt = Buffer.from(accessSaltB64, "base64url");
  return pbkdf2Sync(password + ACCESS_SECRET_CONTEXT, salt, MASTER_PASSWORD_PBKDF2_ITERATIONS, 32, "sha256").toString("base64url");
}

function generateAccessSalt(): string {
  return randomBytes(16).toString("base64url");
}

function srpRegister(accessSecret: string) {
  const srpSalt = srpClient.generateSalt();
  const privateKey = srpClient.derivePrivateKey(srpSalt, SRP_USERNAME, accessSecret);
  return { srpSalt, verifier: srpClient.deriveVerifier(privateKey) };
}

/** Run a full SRP-6a login against the server and return the credential plus
 *  the client-side material needed to verify the server's proof. */
async function srpLogin(app: any, password: string, accessSaltB64: string, label: string) {
  const accessSecret = deriveAccessSecret(password, accessSaltB64);
  const clientEphemeral = srpClient.generateEphemeral();
  const challenge = (
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login/challenge",
      payload: { clientPublicEphemeral: clientEphemeral.public },
    })
  ).json();
  const clientSession = srpClient.deriveSession(
    clientEphemeral.secret,
    challenge.serverPublicEphemeral,
    challenge.srpSalt,
    SRP_USERNAME,
    srpClient.derivePrivateKey(challenge.srpSalt, SRP_USERNAME, accessSecret),
  );
  const result = (
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login/verify",
      payload: {
        challengeId: challenge.challengeId,
        clientPublicEphemeral: clientEphemeral.public,
        clientSessionProof: clientSession.proof,
        label,
      },
    })
  ).json();
  return { deviceToken: result.deviceToken, reauthToken: result.reauthToken, serverSessionProof: result.serverSessionProof, clientEphemeral, clientSession };
}

/** Initialize the master password: derive accessSecret locally, run SRP
 *  registration, and submit {accessSalt, srpSalt, verifier, fileSalt,
 *  fileVerifier} — all derived from the same master password so the server
 *  writes the SRP auth record and the protected-session file record in one
 *  atomic transaction. */
async function initialize(app: any, password = MASTER_PASSWORD, label = "桌面端") {
  const accessSalt = generateAccessSalt();
  const accessSecret = deriveAccessSecret(password, accessSalt);
  const registration = srpRegister(accessSecret);
  // The file salt/verifier are opaque to the server (it only stores them).
  // Use random strings — the client derives and verifies them locally.
  const fileSalt = randomBytes(16).toString("base64url");
  const fileVerifier = randomBytes(32).toString("base64url");
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/devices/initialize",
    payload: { accessSalt, srpSalt: registration.srpSalt, verifier: registration.verifier, fileSalt, fileVerifier, label },
  });
  expect(response.statusCode).toBe(200);
  const credential = response.json() as { deviceId: string; deviceToken: string };
  return { ...credential, accessSalt, fileSalt, fileVerifier };
}

describe("device auth (SRP-6a)", () => {
  let app: any;
  beforeAll(() => {
    app = buildDeviceApp();
  });
  afterAll(() => app.close());

  it("reports uninitialized auth state before setup", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      bootstrapped: false,
      requiresDeviceAuth: true,
      authInitialized: false,
    });
  });

  it("exposes public auth config without verifier or sensitive material", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(response.statusCode).toBe(200);
    const config = response.json();
    expect(config.initialized).toBe(false);
    expect(config.protocolVersion).toBe("srp6a-v1");
    expect(config.kdfVersion).toBe("pbkdf2-sha256-v1");
    expect(config.pbkdf2Iterations).toBe(MASTER_PASSWORD_PBKDF2_ITERATIONS);
    // No salts exist yet before initialization.
    expect(config.accessSalt).toBeUndefined();
    expect(config.srpSalt).toBeUndefined();
  });

  it("allows Capacitor origins but not the packaged desktop loopback or arbitrary origins", async () => {
    // Desktop Electron does NOT need CORS: the main process proxies all
    // remote requests via Node fetch (not subject to CORS). Only the
    // configured server origin is allowed.
    const desktop = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/config",
      headers: {
        origin: "http://127.0.0.1:4318",
        "access-control-request-method": "GET",
      },
    });
    expect(desktop.headers["access-control-allow-origin"]).toBeUndefined();
    const capacitor = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/config",
      headers: {
        origin: "https://localhost",
        "access-control-request-method": "GET",
      },
    });
    expect(capacitor.headers["access-control-allow-origin"]).toBe("https://localhost");
    const untrusted = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/config",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET",
      },
    });
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns a generic authentication failure when challenge is attempted before initialization", async () => {
    const localApp = buildDeviceApp();
    const response = await localApp.inject({
      method: "POST",
      url: "/api/v1/auth/login/challenge",
      payload: { clientPublicEphemeral: srpClient.generateEphemeral().public },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("Authentication failed");
    await localApp.close();
  });

  it("rejects protected APIs before authentication", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/tree" })).statusCode).toBe(401);
  });

  it("initializes the master password, first device, and protected session in one transaction", async () => {
    const { deviceToken, accessSalt, fileSalt, fileVerifier } = await initialize(app);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/tree",
          headers: { authorization: `Bearer ${deviceToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).json()).toMatchObject({
      bootstrapped: true,
      authInitialized: true,
    });
    // The public config now returns the salts (but never the verifier).
    const config = (await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
    expect(config.initialized).toBe(true);
    expect(config.accessSalt).toBe(accessSalt);
    expect(config.srpSalt).toBeTruthy();
    expect(JSON.stringify(config)).not.toContain("verifier");
    // The protected session is also configured — file salt/verifier were
    // written in the same transaction as the SRP auth record.
    const ps = (await app.inject({
      method: "GET",
      url: "/api/v1/protected-session",
      headers: { authorization: `Bearer ${deviceToken}` },
    })).json();
    expect(ps.configured).toBe(true);
    expect(ps.salt).toBe(fileSalt);
    expect(ps.verifier).toBe(fileVerifier);
  });

  it("rejects initialization without file material (unified master-password requirement)", async () => {
    const accessSalt = generateAccessSalt();
    const accessSecret = deriveAccessSecret(MASTER_PASSWORD, accessSalt);
    const registration = srpRegister(accessSecret);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/devices/initialize",
      payload: { accessSalt, srpSalt: registration.srpSalt, verifier: registration.verifier, label: "缺少文件材料" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/fileSalt and fileVerifier are required/);
  });

  it("does not allow master-password reinitialization", async () => {
    const accessSalt = generateAccessSalt();
    const accessSecret = deriveAccessSecret("attacker password", accessSalt);
    const registration = srpRegister(accessSecret);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/devices/initialize",
      payload: {
        accessSalt, srpSalt: registration.srpSalt, verifier: registration.verifier,
        fileSalt: randomBytes(16).toString("base64url"),
        fileVerifier: randomBytes(32).toString("base64url"),
        label: "攻击者",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("completes a correct SRP login and verifies the server proof", async () => {
    const config = (await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
    const { deviceToken, serverSessionProof, clientEphemeral, clientSession } = await srpLogin(
      app,
      MASTER_PASSWORD,
      config.accessSalt,
      "手机",
    );
    expect(deviceToken).toBeTruthy();
    // Mutual authentication: the client MUST verify the server's proof.
    expect(() => srpClient.verifySession(clientEphemeral.public, clientSession, serverSessionProof)).not.toThrow();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/tree",
          headers: { authorization: `Bearer ${deviceToken}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects an incorrect master password without leaking the reason", async () => {
    const config = (await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
    const accessSecret = deriveAccessSecret("incorrect password", config.accessSalt);
    const clientEphemeral = srpClient.generateEphemeral();
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/challenge",
        payload: { clientPublicEphemeral: clientEphemeral.public },
      })
    ).json();
    const clientSession = srpClient.deriveSession(
      clientEphemeral.secret,
      challenge.serverPublicEphemeral,
      challenge.srpSalt,
      SRP_USERNAME,
      srpClient.derivePrivateKey(challenge.srpSalt, SRP_USERNAME, accessSecret),
    );
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login/verify",
      payload: {
        challengeId: challenge.challengeId,
        clientPublicEphemeral: clientEphemeral.public,
        clientSessionProof: clientSession.proof,
        label: "未知设备",
      },
    });
    expect(rejected.statusCode).toBe(401);
    // The error message must not reveal whether the user exists or the password is wrong.
    expect(rejected.json().error.message).not.toMatch(/password|user|exist/i);
  });

  it("rejects a replayed challenge (one-time use)", async () => {
    const config = (await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
    const accessSecret = deriveAccessSecret(MASTER_PASSWORD, config.accessSalt);
    const clientEphemeral = srpClient.generateEphemeral();
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login/challenge",
        payload: { clientPublicEphemeral: clientEphemeral.public },
      })
    ).json();
    const clientSession = srpClient.deriveSession(
      clientEphemeral.secret,
      challenge.serverPublicEphemeral,
      challenge.srpSalt,
      SRP_USERNAME,
      srpClient.derivePrivateKey(challenge.srpSalt, SRP_USERNAME, accessSecret),
    );
    const payload = {
      challengeId: challenge.challengeId,
      clientPublicEphemeral: clientEphemeral.public,
      clientSessionProof: clientSession.proof,
      label: "重放者",
    };
    // First use succeeds and consumes the challenge.
    const first = await app.inject({ method: "POST", url: "/api/v1/auth/login/verify", payload });
    expect(first.statusCode).toBe(200);
    // Replaying the same challengeId must fail — it has been consumed.
    const replay = await app.inject({ method: "POST", url: "/api/v1/auth/login/verify", payload });
    expect(replay.statusCode).toBe(401);
  });

  it("fails client-side when the server proof is forged (mutual auth)", () => {
    // A tampered server proof must be rejected by verifySession, proving the
    // client validates the server and is not vulnerable to a forged response.
    const salt = srpClient.generateSalt();
    const privateKey = srpClient.derivePrivateKey(salt, SRP_USERNAME, "secret");
    const verifier = srpClient.deriveVerifier(privateKey);
    const clientEphemeral = srpClient.generateEphemeral();
    const serverEphemeral = srpServer.generateEphemeral(verifier);
    const clientSession = srpClient.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      salt,
      SRP_USERNAME,
      privateKey,
    );
    const forgedProof = "00".repeat(32);
    expect(() => srpClient.verifySession(clientEphemeral.public, clientSession, forgedProof)).toThrow();
  });

  it("temporarily rate-limits repeated failed logins", async () => {
    const localApp = buildDeviceApp();
    await initialize(localApp);
    const config = (await localApp.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const accessSecret = deriveAccessSecret("incorrect password", config.accessSalt);
      const clientEphemeral = srpClient.generateEphemeral();
      const challenge = (
        await localApp.inject({
          method: "POST",
          url: "/api/v1/auth/login/challenge",
          payload: { clientPublicEphemeral: clientEphemeral.public },
        })
      ).json();
      const clientSession = srpClient.deriveSession(
        clientEphemeral.secret,
        challenge.serverPublicEphemeral,
        challenge.srpSalt,
        SRP_USERNAME,
        srpClient.derivePrivateKey(challenge.srpSalt, SRP_USERNAME, accessSecret),
      );
      const response = await localApp.inject({
        method: "POST",
        url: "/api/v1/auth/login/verify",
        payload: {
          challengeId: challenge.challengeId,
          clientPublicEphemeral: clientEphemeral.public,
          clientSessionProof: clientSession.proof,
          label: "未知设备",
        },
      });
      expect(response.statusCode).toBe(401);
    }
    // After 5 failures, even the challenge step is throttled.
    const clientEphemeral = srpClient.generateEphemeral();
    const blocked = await localApp.inject({
      method: "POST",
      url: "/api/v1/auth/login/challenge",
      payload: { clientPublicEphemeral: clientEphemeral.public },
    });
    expect(blocked.statusCode).toBe(429);
    await localApp.close();
  });

  it("rejects protected-session setup without auth in device-auth mode", async () => {
    const localApp = buildDeviceApp();
    const { deviceToken } = await initialize(localApp);
    // First clear the protected session so setup is a valid operation.
    await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/clear",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    // Setup without auth must be rejected — it would let the file password
    // diverge from the service-access password.
    const rejected = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/setup",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { salt: randomBytes(16).toString("base64url"), verifier: randomBytes(32).toString("base64url") },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toMatch(/auth .* is required when device authentication is enabled/);
    // Setup WITH auth succeeds.
    const config = (await localApp.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
    const accessSecret = deriveAccessSecret(MASTER_PASSWORD, config.accessSalt);
    const registration = srpRegister(accessSecret);
    const ok = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/setup",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        salt: randomBytes(16).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        auth: { accessSalt: config.accessSalt, srpSalt: registration.srpSalt, verifier: registration.verifier },
      },
    });
    expect(ok.statusCode).toBe(200);
    // setup replaced the SRP verifier, so the token which authorized it is
    // revoked along with every other existing device token.
    expect(
      (
        await localApp.inject({
          method: "GET",
          url: "/api/v1/tree",
          headers: { authorization: `Bearer ${deviceToken}` },
        })
      ).statusCode,
    ).toBe(401);
    await localApp.close();
  });

  it("rejects protected-session change-password without auth in device-auth mode", async () => {
    const localApp = buildDeviceApp();
    const { deviceToken } = await initialize(localApp);
    // Change-password without auth must be rejected — it would change only
    // the file password and leave the SRP credential on the old password.
    const rejected = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/change-password",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        salt: randomBytes(16).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        notes: [],
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toMatch(/auth .* is required when device authentication is enabled/);
    await localApp.close();
  });

  it("rejects change-password without reauthToken in device-auth mode", async () => {
    const localApp = buildDeviceApp();
    const { deviceToken, accessSalt } = await initialize(localApp);
    // Step-up reauth is required alongside the new SRP record in device-auth
    // mode. A request with valid `auth` but no reauthToken must be refused.
    const registration = srpRegister(deriveAccessSecret(MASTER_PASSWORD, accessSalt));
    const rejected = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/change-password",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        salt: randomBytes(16).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        notes: [],
        auth: {
          accessSalt,
          srpSalt: registration.srpSalt,
          verifier: registration.verifier,
        },
      },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.message).toMatch(/master-password verification is required/);
    await localApp.close();
  });

  it("rejects change-password with an invalid reauthToken in device-auth mode", async () => {
    const localApp = buildDeviceApp();
    const { deviceToken, accessSalt } = await initialize(localApp);
    const registration = srpRegister(deriveAccessSecret(MASTER_PASSWORD, accessSalt));
    const rejected = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/change-password",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        salt: randomBytes(16).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        notes: [],
        auth: {
          accessSalt,
          srpSalt: registration.srpSalt,
          verifier: registration.verifier,
        },
        reauthToken: randomBytes(32).toString("base64url"),
      },
    });
    expect(rejected.statusCode).toBe(401);
    await localApp.close();
  });

  it("accepts change-password with a valid reauthToken in device-auth mode", async () => {
    const localApp = buildDeviceApp();
    const { deviceToken, accessSalt } = await initialize(localApp);
    // A step-up SRP login yields a fresh reauthToken.
    const login = await srpLogin(localApp, MASTER_PASSWORD, accessSalt, "桌面端");
    const registration = srpRegister(deriveAccessSecret(MASTER_PASSWORD, accessSalt));
    const ok = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/change-password",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        salt: randomBytes(16).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        notes: [],
        auth: {
          accessSalt,
          srpSalt: registration.srpSalt,
          verifier: registration.verifier,
        },
        reauthToken: login.reauthToken,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ configured: true, authReplaced: true });
    await localApp.close();
  });

  it("still allows change-password without reauthToken in local (non-device-auth) mode", async () => {
    const localApp = buildApp({
      databaseUrl: ":memory:",
      enableDeviceAuth: false,
      prettyLogs: false,
    });
    const ok = await localApp.inject({
      method: "POST",
      url: "/api/v1/protected-session/change-password",
      payload: {
        salt: randomBytes(16).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        notes: [],
      },
    });
    // No device-auth step-up requirement locally — only the 400 for missing
    // salt/verifier/notes applies, which this request satisfies.
    expect(ok.statusCode).toBe(200);
    await localApp.close();
  });

  it("still supports one-time pairing from an authenticated device", async () => {
    const localApp = buildDeviceApp();
    const { deviceToken } = await initialize(localApp);
    const pairing = await localApp.inject({
      method: "POST",
      url: "/api/v1/devices/pairing-token",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {},
    });
    const paired = await localApp.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { pairingToken: pairing.json().pairingToken, label: "平板" },
    });
    expect(paired.statusCode).toBe(200);
    await localApp.close();
  });

  it("revokes a device token immediately", async () => {
    const localApp = buildDeviceApp();
    const { deviceId, deviceToken } = await initialize(localApp);
    expect(
      (
        await localApp.inject({
          method: "DELETE",
          url: `/api/v1/devices/${deviceId}`,
          headers: { authorization: `Bearer ${deviceToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await localApp.inject({
          method: "GET",
          url: "/api/v1/tree",
          headers: { authorization: `Bearer ${deviceToken}` },
        })
      ).statusCode,
    ).toBe(401);
    await localApp.close();
  });

  it("isolates sync cursors between authenticated devices", async () => {
    const localApp = buildDeviceApp();
    const first = await initialize(localApp);
    const second = await srpLogin(localApp, MASTER_PASSWORD, first.accessSalt, "第二设备");
    const peerId = "https://sync.example.test";
    const firstAdvance = await localApp.inject({
      method: "POST", url: "/api/v1/sync/advance",
      headers: { authorization: `Bearer ${first.deviceToken}` },
      payload: { peerId, cursor: 7 },
    });
    expect(firstAdvance.statusCode).toBe(200);
    const secondCursor = await localApp.inject({
      method: "GET", url: `/api/v1/sync/cursor?peerId=${encodeURIComponent(peerId)}`,
      headers: { authorization: `Bearer ${second.deviceToken}` },
    });
    expect(secondCursor.json()).toMatchObject({ peerId, lastAdvanceId: 0 });
    await localApp.close();
  });

  it("derives different accessSecrets from different salts (no key reuse)", () => {
    const saltA = generateAccessSalt();
    const saltB = generateAccessSalt();
    const secretA = deriveAccessSecret(MASTER_PASSWORD, saltA);
    const secretB = deriveAccessSecret(MASTER_PASSWORD, saltB);
    expect(secretA).not.toBe(secretB);
  });

  it("stores no master-password or accessSecret plaintext in the database", async () => {
    // The in-memory SQLite is gone after the app closes, so verify against a
    // file-backed DB we can reopen. The settings table must contain only the
    // salts, verifier and version metadata — never the password or accessSecret.
    const dbPath = `./test-auth-${Date.now()}.db`;
    const app = buildApp({ databaseUrl: dbPath, enableDeviceAuth: true, prettyLogs: false });
    await initialize(app);
    const { createDatabase } = await import("@ygdria/database");
    const store = createDatabase(dbPath);
    const settings = store.sqlite.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const keys = new Set(settings.map((s) => s.key));
    const dump = JSON.stringify(settings);
    expect(dump).not.toContain(MASTER_PASSWORD);
    expect(dump).not.toContain("server_access_password");
    // The unified init must have written BOTH the SRP auth record and the
    // protected-session file record — never one without the other.
    expect(keys).toContain("auth_srp_verifier");
    expect(keys).toContain("auth_access_salt");
    expect(keys).toContain("protected_session_salt");
    expect(keys).toContain("protected_session_verifier");
    store.sqlite.close();
    await app.close();
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(dbPath); } catch { /* best effort */ }
  });
});
