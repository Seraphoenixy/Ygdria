import { describe, expect, it } from "vitest";
import * as srpServer from "secure-remote-password/server.js";
import { AUTH_PROTOCOL_VERSION, KDF_VERSION, MASTER_PASSWORD_PBKDF2_ITERATIONS, SRP_USERNAME, ACCESS_SECRET_CONTEXT } from "@ygdria/shared";
import {
  DEFAULT_PROTECTED_SESSION_TIMEOUT_MS,
  MAX_MASTER_PASSWORD_LENGTH,
  ProtectedClientSession,
  assertAuthConfigSupported,
  deriveAccessSecret,
  generateSaltB64,
  srpBeginLogin,
  srpDeriveClientSession,
  srpRegister,
  srpVerifyServer,
  type AuthConfig,
} from "./client-crypto";

describe("ProtectedClientSession password bounds", () => {
  it("starts locked", () => {
    const session = new ProtectedClientSession();
    expect(session.isUnlocked).toBe(false);
    expect(session.timeoutMs).toBe(DEFAULT_PROTECTED_SESSION_TIMEOUT_MS);
  });

  it("rejects an auto-lock timeout below one minute", () => {
    expect(() => new ProtectedClientSession().setTimeoutMs(0)).toThrow("at least one minute");
  });

  it("rejects oversized passwords before deriving a key during setup", async () => {
    const session = new ProtectedClientSession();
    await expect(session.setup("a".repeat(MAX_MASTER_PASSWORD_LENGTH + 1))).rejects.toThrow(
      `Password must not exceed ${MAX_MASTER_PASSWORD_LENGTH} characters`,
    );
  });

  it("rejects oversized passwords before deriving a key during unlock", async () => {
    const session = new ProtectedClientSession();
    await expect(session.unlock("a".repeat(MAX_MASTER_PASSWORD_LENGTH + 1), "ignored", "ignored")).rejects.toThrow(
      `Password must not exceed ${MAX_MASTER_PASSWORD_LENGTH} characters`,
    );
  });
});

describe("master-password access-secret derivation", () => {
  it("derives different accessSecrets for different salts (no key reuse)", async () => {
    const a = await deriveAccessSecret("master-password", generateSaltB64());
    const b = await deriveAccessSecret("master-password", generateSaltB64());
    expect(a).not.toBe(b);
  });

  it("rejects an undersized master password", async () => {
    await expect(deriveAccessSecret("short", generateSaltB64())).rejects.toThrow("at least 8 characters");
  });
});

describe("SRP-6a client/server handshake", () => {
  const masterPassword = "a strong master password";

  it("completes a full PAKE round-trip with mutual proof verification", async () => {
    // Client: derive accessSecret, register (produce srpSalt + verifier).
    const accessSalt = generateSaltB64();
    const accessSecret = await deriveAccessSecret(masterPassword, accessSalt);
    const registration = srpRegister(accessSecret);

    // Server: store verifier; on login, generate a one-time challenge.
    const clientEphemeral = srpBeginLogin();
    const serverEphemeral = srpServer.generateEphemeral(registration.verifier);

    // Client: derive the one-time proof from the server's challenge.
    const clientSession = srpDeriveClientSession(
      clientEphemeral,
      serverEphemeral.public,
      registration.srpSalt,
      accessSecret,
    );

    // Server: verify the client proof and produce the server proof.
    const serverSession = srpServer.deriveSession(
      serverEphemeral.secret,
      clientEphemeral.public,
      registration.srpSalt,
      SRP_USERNAME,
      registration.verifier,
      clientSession.proof,
    );
    // Both sides derive the same shared session key.
    expect(serverSession.key).toBe(clientSession.key);

    // Client: verify the server proof (mutual authentication).
    expect(() => srpVerifyServer(clientEphemeral, clientSession, serverSession.proof)).not.toThrow();
  });

  it("fails when the wrong master password is used (proofs mismatch)", async () => {
    const accessSalt = generateSaltB64();
    const correctSecret = await deriveAccessSecret(masterPassword, accessSalt);
    const wrongSecret = await deriveAccessSecret("wrong password", accessSalt);
    const registration = srpRegister(correctSecret);

    const clientEphemeral = srpBeginLogin();
    const serverEphemeral = srpServer.generateEphemeral(registration.verifier);
    // Client derives a proof with the WRONG accessSecret.
    const clientSession = srpDeriveClientSession(
      clientEphemeral,
      serverEphemeral.public,
      registration.srpSalt,
      wrongSecret,
    );
    // Server rejects the proof: deriveSession throws on a bad client proof.
    expect(() =>
      srpServer.deriveSession(
        serverEphemeral.secret,
        clientEphemeral.public,
        registration.srpSalt,
        SRP_USERNAME,
        registration.verifier,
        clientSession.proof,
      ),
    ).toThrow();
  });

  it("rejects a forged server proof (client-side mutual auth)", async () => {
    const accessSalt = generateSaltB64();
    const accessSecret = await deriveAccessSecret(masterPassword, accessSalt);
    const registration = srpRegister(accessSecret);
    const clientEphemeral = srpBeginLogin();
    const serverEphemeral = srpServer.generateEphemeral(registration.verifier);
    const clientSession = srpDeriveClientSession(
      clientEphemeral,
      serverEphemeral.public,
      registration.srpSalt,
      accessSecret,
    );
    // A tampered server proof must be rejected by the client.
    expect(() => srpVerifyServer(clientEphemeral, clientSession, "00".repeat(32))).toThrow();
  });
});

describe("assertAuthConfigSupported", () => {
  function validConfig(): AuthConfig {
    return {
      initialized: true,
      protocolVersion: AUTH_PROTOCOL_VERSION,
      kdfVersion: KDF_VERSION,
      pbkdf2Iterations: MASTER_PASSWORD_PBKDF2_ITERATIONS,
      accessSalt: generateSaltB64(),
      srpSalt: "some-salt",
      accessSecretContext: ACCESS_SECRET_CONTEXT,
      srpUsername: SRP_USERNAME,
    };
  }

  it("accepts a config matching the compiled-in constants", () => {
    expect(() => assertAuthConfigSupported(validConfig())).not.toThrow();
  });

  it("rejects an unsupported protocol version", () => {
    const c = validConfig();
    c.protocolVersion = "srp6a-v9";
    expect(() => assertAuthConfigSupported(c)).toThrow("Unsupported auth protocol version");
  });

  it("rejects an unsupported KDF version", () => {
    const c = validConfig();
    c.kdfVersion = "argon2-v1";
    expect(() => assertAuthConfigSupported(c)).toThrow("Unsupported KDF version");
  });

  it("rejects a mismatched PBKDF2 iteration count", () => {
    const c = validConfig();
    c.pbkdf2Iterations = 1000;
    expect(() => assertAuthConfigSupported(c)).toThrow("Unsupported PBKDF2 iterations");
  });

  it("rejects a mismatched access-secret context", () => {
    const c = validConfig();
    c.accessSecretContext = "other-context";
    expect(() => assertAuthConfigSupported(c)).toThrow("Unsupported access-secret context");
  });

  it("rejects a mismatched SRP username", () => {
    const c = validConfig();
    c.srpUsername = "someone-else";
    expect(() => assertAuthConfigSupported(c)).toThrow("Unsupported SRP username");
  });
});
