import { createHash, randomBytes, randomUUID } from "node:crypto";

export const ETAPI_SCOPES = ["notes:read", "notes:write"] as const;
export type EtapiScope = (typeof ETAPI_SCOPES)[number];

export const DEFAULT_ETAPI_SESSION_TTL_SECONDS = 15 * 60;
export const MAX_ETAPI_SESSION_TTL_SECONDS = 60 * 60;
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
  interface FastifyRequest {
    etapiSession?: EtapiSession;
  }
}

interface EtapiSessionRecord extends EtapiSession {
  tokenHash: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * In-memory, revocable credentials for external automation and AI tools.
 * Plaintext tokens are returned exactly once and are never retained.
 */
export class EtapiSessions {
  private sessionsById = new Map<string, EtapiSessionRecord>();
  private sessionIdByTokenHash = new Map<string, string>();

  constructor(private readonly clock: () => number = Date.now) {}

  issue(input: {
    label: string;
    scopes: EtapiScope[];
    ttlSeconds?: number;
    issuedByDeviceId?: string | null;
  }): EtapiSession & { accessToken: string } {
    this.pruneExpired();
    while (this.sessionsById.size >= MAX_ETAPI_SESSIONS) {
      const oldest = [...this.sessionsById.values()].sort(
        (left, right) => left.createdAt - right.createdAt,
      )[0];
      if (!oldest) break;
      this.revoke(oldest.id);
    }

    const now = this.clock();
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_ETAPI_SESSION_TTL_SECONDS;
    const id = randomUUID();
    const accessToken = `yg_etapi_${randomBytes(ETAPI_TOKEN_BYTES).toString("base64url")}`;
    const record: EtapiSessionRecord = {
      id,
      label: input.label.trim(),
      scopes: [...new Set(input.scopes)],
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      issuedByDeviceId: input.issuedByDeviceId ?? null,
      tokenHash: sha256Hex(accessToken),
    };
    this.sessionsById.set(id, record);
    this.sessionIdByTokenHash.set(record.tokenHash, id);
    return { ...this.publicSession(record), accessToken };
  }

  verify(accessToken: string): EtapiSession | null {
    const sessionId = this.sessionIdByTokenHash.get(sha256Hex(accessToken));
    if (!sessionId) return null;
    const record = this.sessionsById.get(sessionId);
    if (!record || record.expiresAt <= this.clock()) {
      if (record) this.revoke(record.id);
      return null;
    }
    return this.publicSession(record);
  }

  list(): EtapiSession[] {
    this.pruneExpired();
    return [...this.sessionsById.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => this.publicSession(record));
  }

  revoke(sessionId: string): boolean {
    const record = this.sessionsById.get(sessionId);
    if (!record) return false;
    this.sessionsById.delete(sessionId);
    this.sessionIdByTokenHash.delete(record.tokenHash);
    return true;
  }

  private pruneExpired(): void {
    const now = this.clock();
    for (const record of this.sessionsById.values()) {
      if (record.expiresAt <= now) this.revoke(record.id);
    }
  }

  private publicSession(record: EtapiSessionRecord): EtapiSession {
    const { tokenHash: _hidden, ...session } = record;
    return { ...session, scopes: [...session.scopes] };
  }
}
