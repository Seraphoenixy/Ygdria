/**
 * Client-side encryption and authentication for the unified master-password model.
 *
 * Principles:
 *  - The master password NEVER leaves the client.
 *  - Two independent secrets are derived from it, each with its own random
 *    salt: a file key (AES-256-GCM, non-extractable, for protected notes)
 *    and an access secret (raw bytes fed to SRP-6a for service login).
 *  - The file key lives only in client memory (never persisted).
 *  - Server stores only ciphertext, the two salts, and the SRP verifier —
 *    never the password, the file key, the access secret, or a static hash.
 *  - Auto-lock destroys the in-memory file key.
 *  - Authentication is a PAKE (SRP-6a) challenge-response: no replayable
 *    material is ever sent; the server's proof is verified for mutual auth.
 */

import * as srpClient from "secure-remote-password/client.js";
import {
  ACCESS_SECRET_CONTEXT,
  AUTH_PROTOCOL_VERSION,
  DERIVED_KEY_BITS,
  KDF_VERSION,
  MASTER_PASSWORD_PBKDF2_ITERATIONS,
  MAX_MASTER_PASSWORD_LENGTH,
  MIN_MASTER_PASSWORD_LENGTH,
  SALT_BYTES,
  SRP_USERNAME,
} from "@ygdria/shared";

const AES_ALGORITHM = "AES-GCM";
const AES_KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = MASTER_PASSWORD_PBKDF2_ITERATIONS;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const DEFAULT_PROTECTED_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_PROTECTED_SESSION_TIMEOUT_MS = 60 * 1000;
/** Re-exported so UI modules import password bounds from a single place. */
export { MAX_MASTER_PASSWORD_LENGTH, MIN_MASTER_PASSWORD_LENGTH };
/** Fixed plaintext encrypted with the derived key to produce a verifier. */
const VERIFIER_PLAINTEXT = "ygdria-protected-verifier-v1";

export type EncryptionPayload = {
  /** Encrypted payload: "v1.{base64url(iv)}.{base64url(tag)}.{base64url(ciphertext)}" */
  ciphertext: string;
};

export type ProtectedPayload = {
  title: string;
  content: unknown;
  propertiesJson: string;
};

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function ab2str(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

function str2bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Derive an AES-256-GCM key from a password and salt using PBKDF2. */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    str2bytes(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertPasswordLength(password: string) {
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) throw new Error("Password must be at least 8 characters");
  if (password.length > MAX_MASTER_PASSWORD_LENGTH)
    throw new Error(`Password must not exceed ${MAX_MASTER_PASSWORD_LENGTH} characters`);
}

// ---------------------------------------------------------------------------
// Unified master-password derivation: file key + access secret (SRP)
// ---------------------------------------------------------------------------
// The file key keeps its existing derivation so existing protected notes still
// decrypt. The access secret is a SEPARATE derivation (different random salt
// + ACCESS_SECRET_CONTEXT) whose raw bytes feed SRP-6a as the password; it
// never leaves the client and is never persisted.

/** Generate a fresh 16-byte random salt, base64url-encoded. */
export function generateSaltB64(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Derive the access secret from the master password and accessSalt.
 * PBKDF2-SHA256(masterPassword || ACCESS_SECRET_CONTEXT, accessSalt) → 32 bytes.
 * The context string provides domain separation from the file-key path. The
 * result is base64url-encoded so it can be passed to the SRP-6a client as the
 * "password" input; it is never sent to the server.
 */
export async function deriveAccessSecret(masterPassword: string, accessSaltB64: string): Promise<string> {
  assertPasswordLength(masterPassword);
  const salt = base64urlDecode(accessSaltB64);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    str2bytes(masterPassword + ACCESS_SECRET_CONTEXT) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    DERIVED_KEY_BITS,
  );
  return base64url(bits);
}

/** Result of SRP-6a registration: the material the server stores (no secret). */
export type SrpRegistration = {
  srpSalt: string;
  verifier: string;
};

/**
 * Run SRP-6a registration locally: generate an SRP salt, derive the private
 * key from (srpSalt, SRP_USERNAME, accessSecret) and the verifier from that.
 * Returns { srpSalt, verifier } — neither is secret; both are sent to the
 * server. accessSecret and the master password are never transmitted.
 */
export function srpRegister(accessSecret: string): SrpRegistration {
  const srpSalt = srpClient.generateSalt();
  const privateKey = srpClient.derivePrivateKey(srpSalt, SRP_USERNAME, accessSecret);
  const verifier = srpClient.deriveVerifier(privateKey);
  return { srpSalt, verifier };
}

/** Client ephemeral pair generated at the start of an SRP login. */
export type SrpClientEphemeral = { secret: string; public: string };

/** Begin an SRP login: generate the client's one-time ephemeral pair. */
export function srpBeginLogin(): SrpClientEphemeral {
  return srpClient.generateEphemeral();
}

/** Result of deriving the client session: the one-time proof to send. */
export type SrpClientSession = { key: string; proof: string };

/**
 * Derive the client session and one-time proof from the server's challenge.
 * Returns { clientSessionProof } for the server; the shared session key is
 * held only in memory and discarded after the server proof is verified.
 */
export function srpDeriveClientSession(
  clientEphemeral: SrpClientEphemeral,
  serverPublicEphemeral: string,
  srpSalt: string,
  accessSecret: string,
): SrpClientSession {
  const privateKey = srpClient.derivePrivateKey(srpSalt, SRP_USERNAME, accessSecret);
  return srpClient.deriveSession(clientEphemeral.secret, serverPublicEphemeral, srpSalt, SRP_USERNAME, privateKey);
}

/**
 * Verify the server's session proof for mutual authentication. Throws if the
 * server proof is invalid (e.g. a man-in-the-middle or forged response), which
 * the caller must surface as an authentication failure.
 */
export function srpVerifyServer(clientEphemeral: SrpClientEphemeral, clientSession: SrpClientSession, serverSessionProof: string): void {
  srpClient.verifySession(clientEphemeral.public, clientSession, serverSessionProof);
}

// ---------------------------------------------------------------------------
// Protocol/KDF version validation
// ---------------------------------------------------------------------------
// The server persists and returns auth_protocol_version, auth_kdf_version and
// pbkdf2_iterations so that future migrations can be detected. The client
// currently only supports the single version compiled into @ygdria/shared.
// If the server reports a version the client does not recognise, we fail
// closed with a clear message rather than silently using the wrong KDF.

export type AuthConfig = {
  initialized: boolean;
  protocolVersion: string;
  kdfVersion: string;
  pbkdf2Iterations: number;
  accessSalt?: string;
  srpSalt?: string;
  accessSecretContext: string;
  srpUsername: string;
};

/**
 * Verify that the server's auth config is compatible with this client's
 * compiled-in protocol/KDF constants. Throws a descriptive error if the server
 * uses a version the client does not support — the user should update the
 * client. Call this before deriving any material from the server's config.
 */
export function assertAuthConfigSupported(config: AuthConfig): void {
  if (config.protocolVersion !== AUTH_PROTOCOL_VERSION)
    throw new Error(
      `Unsupported auth protocol version: server uses "${config.protocolVersion}", client supports "${AUTH_PROTOCOL_VERSION}". Please update your client.`,
    );
  if (config.kdfVersion !== KDF_VERSION)
    throw new Error(
      `Unsupported KDF version: server uses "${config.kdfVersion}", client supports "${KDF_VERSION}". Please update your client.`,
    );
  if (config.pbkdf2Iterations !== MASTER_PASSWORD_PBKDF2_ITERATIONS)
    throw new Error(
      `Unsupported PBKDF2 iterations: server uses ${config.pbkdf2Iterations}, client supports ${MASTER_PASSWORD_PBKDF2_ITERATIONS}. Please update your client.`,
    );
  if (config.accessSecretContext !== ACCESS_SECRET_CONTEXT)
    throw new Error(
      `Unsupported access-secret context: server uses "${config.accessSecretContext}", client supports "${ACCESS_SECRET_CONTEXT}". Please update your client.`,
    );
  if (config.srpUsername !== SRP_USERNAME)
    throw new Error(
      `Unsupported SRP username: server uses "${config.srpUsername}", client supports "${SRP_USERNAME}". Please update your client.`,
    );
}

/**
 * Create a verifier by encrypting a known plaintext with the derived key.
 * This avoids exporting the raw key (which is non-extractable).
 * The verifier is stored on the server and used to validate the password
 * during unlock without ever sending the password or key to the server.
 */
async function createVerifier(key: CryptoKey): Promise<string> {
  // Use a zero IV — acceptable here because each key is unique and this
  // plaintext is only encrypted once per key.
  const iv = new Uint8Array(IV_BYTES);
  const encrypted = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv: iv as BufferSource, tagLength: 128 },
    key,
    str2bytes(VERIFIER_PLAINTEXT) as BufferSource,
  );
  return base64url(encrypted);
}

/** Verify a derived key against a stored verifier by attempting decryption. */
async function verifyKey(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    const iv = new Uint8Array(IV_BYTES);
    const verifierBytes = base64urlDecode(verifier);
    await crypto.subtle.decrypt(
      { name: AES_ALGORITHM, iv: iv as BufferSource, tagLength: 128 },
      key,
      verifierBytes as BufferSource,
    );
    return true;
  } catch {
    return false;
  }
}

/** Generate a random salt for key derivation. */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** Encrypt a value using the derived key. Returns the ciphertext string. */
async function encrypt(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = str2bytes(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv: iv as BufferSource, tagLength: 128 },
    key,
    encoded as BufferSource,
  );
  // AES-GCM appends the auth tag to the ciphertext
  const ciphertext = new Uint8Array(encrypted.slice(0, encrypted.byteLength - TAG_BYTES));
  const tag = new Uint8Array(encrypted.slice(encrypted.byteLength - TAG_BYTES));
  return `v1.${base64url(iv)}.${base64url(tag)}.${base64url(ciphertext)}`;
}

/** Decrypt a ciphertext string using the derived key. */
async function decrypt<T>(key: CryptoKey, payload: string): Promise<T> {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid protected payload");
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const iv = base64urlDecode(ivB64!);
  const tag = base64urlDecode(tagB64!);
  const ciphertext = base64urlDecode(ciphertextB64!);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv: iv as BufferSource, tagLength: 128 },
    key,
    combined as BufferSource,
  );
  return JSON.parse(ab2str(decrypted)) as T;
}

/**
 * Client-side protected session.
 *
 * Manages the derived key in memory with an auto-lock timeout.
 * The key is never persisted; it is destroyed on lock().
 */
export class ProtectedClientSession {
  private key: CryptoKey | null = null;
  private lastActivity = 0;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _timeoutMs = DEFAULT_PROTECTED_SESSION_TIMEOUT_MS;
  private _salt: Uint8Array | null = null;
  private _verifier: string | null = null;
  private _onLock: (() => void) | null = null;

  get isConfigured(): boolean {
    return this._salt !== null && this._verifier !== null;
  }

  get isUnlocked(): boolean {
    if (!this.key) return false;
    if (this._timeoutMs > 0 && Date.now() - this.lastActivity >= this._timeoutMs) {
      this.lock();
      return false;
    }
    return true;
  }

  get salt(): string | null {
    return this._salt ? base64url(this._salt) : null;
  }

  get verifier(): string | null {
    return this._verifier;
  }

  get timeoutMs(): number {
    return this._timeoutMs;
  }

  /** Configure a new password. Generates salt and verifier, derives the key. */
  async setup(password: string): Promise<void> {
    assertPasswordLength(password);
    this.lock();
    this._salt = generateSalt();
    this.key = await deriveKey(password, this._salt);
    this._verifier = await createVerifier(this.key);
    this._touch();
  }

  /** Unlock with the stored salt and verifier. */
  async unlock(password: string, saltB64: string, verifier: string): Promise<void> {
    assertPasswordLength(password);
    this.lock();
    const salt = base64urlDecode(saltB64);
    const key = await deriveKey(password, salt);
    const ok = await verifyKey(key, verifier);
    if (!ok) {
      throw new Error("Incorrect password");
    }
    this._salt = salt;
    this._verifier = verifier;
    this.key = key;
    this._touch();
  }

  /** Lock the session: destroy the key and clear the timer. */
  lock(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    this.key = null;
    this.lastActivity = 0;
    this._onLock?.();
  }

  /** Register a callback that fires when the session locks (manual or auto). */
  setOnLock(cb: (() => void) | null): void {
    this._onLock = cb;
  }

  /** Set the auto-lock timeout in milliseconds. */
  setTimeoutMs(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < MIN_PROTECTED_SESSION_TIMEOUT_MS)
      throw new Error("Protected session timeout must be at least one minute");
    this._timeoutMs = ms;
    if (this.key) this._scheduleLock();
  }

  /** Encrypt a value. Throws if locked. */
  async encrypt(value: unknown): Promise<string> {
    if (!this.isUnlocked || !this.key) throw new Error("Protected session is locked");
    this._touch();
    return encrypt(this.key, value);
  }

  /** Decrypt a payload. Throws if locked. */
  async decrypt<T>(payload: string): Promise<T> {
    if (!this.isUnlocked || !this.key) throw new Error("Protected session is locked");
    this._touch();
    return decrypt<T>(this.key, payload);
  }

  /** Reset session state. */
  reset(): void {
    this.lock();
    this._salt = null;
    this._verifier = null;
  }

  private _touch(): void {
    this.lastActivity = Date.now();
    this._scheduleLock();
  }

  private _scheduleLock(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => this.lock(), this._timeoutMs);
  }
}
