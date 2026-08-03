export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

// --- schemas (was schemas.ts) ---

export function parse(schema: any, value: any, log?: { debug: (obj: object, msg: string) => void }) {
  const r = schema.safeParse(value);
  if (!r.success) {
    if (log) log.debug({ issues: r.error.issues }, "request validation failed");
    throw httpError(400, "Invalid request data");
  }
  return r.data;
}

// --- constants (was constants.ts) ---

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
export const LOGIN_RATE_LIMIT_MAX_REQUESTS = 20;
export const LOGIN_FAILURE_RETENTION_MS = 10 * 60 * 1000;
export const MAX_SECURITY_STATE_RECORDS = 10_000;
export const SRP_LOGIN_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PROTECTED_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// --- context (was context.ts) ---

/** Only the embedded desktop server has a local-token boundary. On that
 * trusted loopback API, the renderer can mark a write as materialized from
 * its configured remote peer. Standalone servers never honor this marker:
 * a connected device must always create changes for its other peers. */
export function isPulledRemoteWrite(
  req: { headers: Record<string, string | string[] | undefined> },
  localToken?: string,
) {
  return Boolean(localToken) && req.headers["x-ygdria-sync-origin"] === "remote";
}

/**
 * Returned when a sync peer has been silent long enough that the server has
 * gated it behind a mandatory snapshot re-baseline. The peer must rebuild from
 * `/api/v1/sync/snapshot` and confirm its cursor before incremental
 * pull/push is accepted again. Carries `code: SYNC_REBASELINE_REQUIRED` so the
 * HTTP client can branch without matching message text.
 */
export class SyncRebaselineRequiredError extends Error {
  statusCode = 409;
  code = "SYNC_REBASELINE_REQUIRED";
  constructor(public peerId: string) {
    super("Sync peer must re-baseline from the full snapshot before resuming incremental sync");
  }
}
