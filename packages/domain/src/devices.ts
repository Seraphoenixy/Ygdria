import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEVICE_TOKEN_IDLE_TIMEOUT_MS } from "@ygdria/shared";

/**
 * In-memory device credential store. Intentionally NOT persisted: server
 * restart requires re-pairing every device. This guarantees credentials
 * never travel through the database sync path between form A (desktop
 * embedded) and form B (standalone server).
 *
 * Only SHA-256(token) is retained; plaintext deviceToken and pairingToken
 * are returned to the caller exactly once at issuance and never stored.
 *
 * Sliding idle timeout: every authenticated request refreshes `lastActiveAt`.
 * A token unused for longer than DEVICE_TOKEN_IDLE_TIMEOUT_MS (5 days, fixed)
 * is deleted on the next use and the request is rejected with 401.
 */
const DEVICE_TOKEN_BYTES = 32;
const PAIRING_TOKEN_BYTES = 32;
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastActiveAt: number | null;
}

interface DeviceRecord extends Device {
  tokenHash: string;
}

interface PairingRecord {
  tokenHash: string;
  expiresAt: number;
  usedAt: number | null;
  createdByDeviceId: string | null;
}

export class DeviceError extends Error {
  constructor(message: string, readonly code: "already_bootstrapped" | "not_bootstrapped" | "invalid_token" | "expired_token" | "used_token" | "device_not_found" | "label_required") {
    super(message);
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export class Devices {
  private devicesById = new Map<string, DeviceRecord>();
  private deviceIdByTokenHash = new Map<string, string>();
  private pairingByTokenHash = new Map<string, PairingRecord>();

  /** True once at least one device has been paired. */
  isBootstrapped(): boolean {
    return this.devicesById.size > 0;
  }

  /** List all paired devices (token hashes are not exposed). */
  list(): Device[] {
    return [...this.devicesById.values()].map(({ tokenHash: _ignored, ...rest }) => rest);
  }

  get(deviceId: string): Device | undefined {
    const record = this.devicesById.get(deviceId);
    if (!record) return undefined;
    const { tokenHash: _ignored, ...rest } = record;
    return rest;
  }

  /**
   * Verify a bearer token. Returns the matching device and refreshes
   * `lastActiveAt`, or null if the token is unknown OR has been idle for
   * longer than the fixed 5-day window (in which case the record is deleted
   * on the spot so the slot is reclaimed and the request is rejected).
   */
  verify(deviceToken: string): Device | null {
    const hash = sha256Hex(deviceToken);
    const deviceId = this.deviceIdByTokenHash.get(hash);
    if (!deviceId) return null;
    const record = this.devicesById.get(deviceId);
    if (!record) return null;
    // lastActiveAt is always set at issuance; a null value (should not happen)
    // is treated as immediately expired so the record is reclaimed.
    if (Date.now() - (record.lastActiveAt ?? 0) > DEVICE_TOKEN_IDLE_TIMEOUT_MS) {
      this.deviceIdByTokenHash.delete(record.tokenHash);
      this.devicesById.delete(deviceId);
      return null;
    }
    record.lastActiveAt = Date.now();
    const { tokenHash: _ignored, ...rest } = record;
    return rest;
  }

  /**
   * Issue a one-time bootstrap pairing token. Only allowed when no device
   * has been paired yet — the first device is bootstrapped from the server
   * host (CLI) and every subsequent device is paired from an existing one.
   */
  createBootstrapPairingToken(ttlMs = DEFAULT_PAIRING_TTL_MS): { pairingToken: string; expiresAt: number } {
    if (this.isBootstrapped()) throw new DeviceError("Server already bootstrapped", "already_bootstrapped");
    return this.issuePairingToken(null, ttlMs);
  }

  /**
   * Issue a one-time pairing token from an already-paired device. Used by
   * the desktop client to display a QR that the mobile client scans.
   */
  createPairingToken(createdByDeviceId: string, ttlMs = DEFAULT_PAIRING_TTL_MS): { pairingToken: string; expiresAt: number } {
    if (!this.devicesById.has(createdByDeviceId)) throw new DeviceError("Creator device not found", "device_not_found");
    return this.issuePairingToken(createdByDeviceId, ttlMs);
  }

  private issuePairingToken(createdByDeviceId: string | null, ttlMs: number): { pairingToken: string; expiresAt: number } {
    this.pruneExpiredPairingTokens();
    const pairingToken = randomToken(PAIRING_TOKEN_BYTES);
    const tokenHash = sha256Hex(pairingToken);
    const expiresAt = Date.now() + ttlMs;
    this.pairingByTokenHash.set(tokenHash, {
      tokenHash,
      expiresAt,
      usedAt: null,
      createdByDeviceId,
    });
    return { pairingToken, expiresAt };
  }

  /**
   * Consume a one-time pairing token and issue a new device credential.
   * The pairing token is invalidated regardless of outcome.
   */
  pair(pairingToken: string, label: string): { deviceId: string; deviceToken: string } {
    if (!label || !label.trim()) throw new DeviceError("label is required", "label_required");
    const hash = sha256Hex(pairingToken);
    const record = this.pairingByTokenHash.get(hash);
    if (!record) throw new DeviceError("Invalid pairing token", "invalid_token");
    if (record.usedAt !== null) throw new DeviceError("Pairing token already used", "used_token");
    if (Date.now() >= record.expiresAt) {
      this.pairingByTokenHash.delete(hash);
      throw new DeviceError("Pairing token expired", "expired_token");
    }
    record.usedAt = Date.now();
    this.pairingByTokenHash.delete(hash);

    return this.issueDevice(label);
  }

  /** Issue a device credential after an external authenticator has approved it. */
  issueDevice(label: string): { deviceId: string; deviceToken: string } {
    if (!label || !label.trim()) throw new DeviceError("label is required", "label_required");
    const deviceToken = randomToken(DEVICE_TOKEN_BYTES);
    const deviceId = randomUUID();
    const now = Date.now();
    const deviceRecord: DeviceRecord = {
      id: deviceId,
      label: label.trim(),
      tokenHash: sha256Hex(deviceToken),
      createdAt: now,
      lastActiveAt: now,
    };
    this.devicesById.set(deviceId, deviceRecord);
    this.deviceIdByTokenHash.set(deviceRecord.tokenHash, deviceId);
    return { deviceId, deviceToken };
  }

  /** Revoke a single device by id. Its token becomes invalid immediately. */
  revoke(deviceId: string): void {
    const record = this.devicesById.get(deviceId);
    if (!record) throw new DeviceError("Device not found", "device_not_found");
    this.deviceIdByTokenHash.delete(record.tokenHash);
    this.devicesById.delete(deviceId);
  }

  /** Revoke every device except the given one. Returns the number revoked. */
  revokeAllExcept(keepDeviceId: string): number {
    if (!this.devicesById.has(keepDeviceId)) throw new DeviceError("Device not found", "device_not_found");
    let count = 0;
    for (const [id, record] of this.devicesById) {
      if (id === keepDeviceId) continue;
      this.deviceIdByTokenHash.delete(record.tokenHash);
      this.devicesById.delete(id);
      count++;
    }
    return count;
  }

  /** Revoke every device including the caller. Used after a master-password
   *  change so that every existing token is invalidated and each client must
   *  re-authenticate with the new master password. */
  revokeAll(): number {
    const count = this.devicesById.size;
    this.devicesById.clear();
    this.deviceIdByTokenHash.clear();
    return count;
  }

  private pruneExpiredPairingTokens(): void {
    const now = Date.now();
    for (const [hash, record] of this.pairingByTokenHash) {
      if (record.usedAt !== null || now >= record.expiresAt) {
        this.pairingByTokenHash.delete(hash);
      }
    }
  }
}
