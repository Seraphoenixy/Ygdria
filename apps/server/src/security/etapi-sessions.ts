import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ETAPI_SCOPES = ["notes:read", "notes:write"] as const;
export type EtapiScope = (typeof ETAPI_SCOPES)[number];

export const DEFAULT_ETAPI_SESSION_TTL_SECONDS = 15 * 60;
export const MAX_ETAPI_SESSION_TTL_SECONDS = 8 * 60 * 60;
const ETAPI_TOKEN_BYTES = 32;
const MAX_ETAPI_SESSIONS = 100;

export interface EtapiSession {
  id: string;
  label: string;
  scopes: EtapiScope[];
  createdAt: number;
  expiresAt: number;
  issuedByDeviceId: string | null;
}

declare module "fastify" {
  interface FastifyRequest { etapiSession?: EtapiSession; }
}

interface EtapiSessionRecord extends EtapiSession { tokenHash: string; }
function sha256Hex(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/**
 * Revocable ETAPI credentials. A desktop-only sidecar file holds hashes and
 * metadata, never plaintext tokens; it is intentionally outside the database
 * and therefore outside sync and database backups.
 */
export class EtapiSessions {
  private sessionsById = new Map<string, EtapiSessionRecord>();
  private sessionIdByTokenHash = new Map<string, string>();
  private readonly storePath?: string;
  private readonly clock: () => number;

  constructor(storePathOrClock?: string | (() => number), clock: () => number = Date.now) {
    if (typeof storePathOrClock === "function") this.clock = storePathOrClock;
    else { this.storePath = storePathOrClock; this.clock = clock; this.load(); }
  }

  issue(input: { label: string; scopes: EtapiScope[]; ttlSeconds?: number; issuedByDeviceId?: string | null }): EtapiSession & { accessToken: string } {
    this.pruneExpired();
    while (this.sessionsById.size >= MAX_ETAPI_SESSIONS) {
      const oldest = [...this.sessionsById.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) break;
      this.revoke(oldest.id);
    }
    const now = this.clock();
    const accessToken = `yg_etapi_${randomBytes(ETAPI_TOKEN_BYTES).toString("base64url")}`;
    const record: EtapiSessionRecord = {
      id: randomUUID(), label: input.label.trim(), scopes: [...new Set(input.scopes)],
      createdAt: now, expiresAt: now + (input.ttlSeconds ?? DEFAULT_ETAPI_SESSION_TTL_SECONDS) * 1000,
      issuedByDeviceId: input.issuedByDeviceId ?? null, tokenHash: sha256Hex(accessToken),
    };
    this.sessionsById.set(record.id, record);
    this.sessionIdByTokenHash.set(record.tokenHash, record.id);
    this.save();
    return { ...this.publicSession(record), accessToken };
  }

  verify(accessToken: string): EtapiSession | null {
    const sessionId = this.sessionIdByTokenHash.get(sha256Hex(accessToken));
    const record = sessionId ? this.sessionsById.get(sessionId) : undefined;
    if (!record || record.expiresAt <= this.clock()) {
      if (record) this.revoke(record.id);
      return null;
    }
    return this.publicSession(record);
  }

  list(): EtapiSession[] {
    this.pruneExpired();
    return [...this.sessionsById.values()].sort((left, right) => right.createdAt - left.createdAt).map((record) => this.publicSession(record));
  }

  revoke(sessionId: string): boolean {
    const record = this.sessionsById.get(sessionId);
    if (!record) return false;
    this.sessionsById.delete(sessionId);
    this.sessionIdByTokenHash.delete(record.tokenHash);
    this.save();
    return true;
  }

  private pruneExpired(): void {
    let changed = false;
    for (const record of this.sessionsById.values()) {
      if (record.expiresAt <= this.clock()) {
        this.sessionsById.delete(record.id);
        this.sessionIdByTokenHash.delete(record.tokenHash);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const records: unknown = JSON.parse(readFileSync(this.storePath, "utf8"));
      if (!Array.isArray(records)) return;
      for (const item of records) {
        if (!item || typeof item !== "object") continue;
        const record = item as EtapiSessionRecord;
        if (typeof record.id !== "string" || typeof record.tokenHash !== "string" || typeof record.label !== "string" ||
          !Array.isArray(record.scopes) || !record.scopes.every((scope) => ETAPI_SCOPES.includes(scope)) ||
          !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt) || record.expiresAt <= this.clock()) continue;
        this.sessionsById.set(record.id, { ...record, scopes: [...record.scopes] });
        this.sessionIdByTokenHash.set(record.tokenHash, record.id);
      }
      this.save();
    } catch { /* a corrupt local cache is treated as an empty credential store */ }
  }

  private save(): void {
    if (!this.storePath) return;
    mkdirSync(dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.sessionsById.values()]));
    renameSync(temporary, this.storePath);
  }

  private publicSession(record: EtapiSessionRecord): EtapiSession {
    const { tokenHash: _hidden, ...session } = record;
    return { ...session, scopes: [...session.scopes] };
  }
}
