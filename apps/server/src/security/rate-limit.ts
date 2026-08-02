import type { FastifyInstance } from "fastify";
import { LOGIN_FAILURE_RETENTION_MS, LOGIN_RATE_LIMIT_MAX_REQUESTS, LOGIN_RATE_LIMIT_WINDOW_MS, MAX_SECURITY_STATE_RECORDS } from "../http/errors.js";

/**
 * Structured security event logger. Logs only de-identified metadata —
 * never passwords, tokens, SRP secrets, file keys, or attachment content.
 */
export function securityLog(app: FastifyInstance, event: string, meta: Record<string, unknown>): void {
  app.log.info({ securityEvent: event, ...meta }, `security: ${event}`);
}

/** Record a failed login attempt and engage a short cool-off after 5 misses
 *  from the same source, to throttle online guessing and SRP compute load. */
export function recordLoginFailure(
  failures: Map<string, { failures: number; blockedUntil: number; expiresAt: number }>,
  ip: string | undefined,
) {
  pruneExpiredLoginFailures(failures);
  evictOldest(failures, MAX_SECURITY_STATE_RECORDS);
  const key = ip ?? "unknown";
  const prev = failures.get(key);
  const count = (prev?.failures ?? 0) + 1;
  const now = Date.now();
  failures.set(key, {
    failures: count,
    blockedUntil: count >= 5 ? now + 30_000 : 0,
    expiresAt: now + LOGIN_FAILURE_RETENTION_MS,
  });
}

export function pruneExpiredLoginFailures(failures: Map<string, { expiresAt: number }>) {
  const now = Date.now();
  for (const [key, failure] of failures) if (failure.expiresAt <= now) failures.delete(key);
}

/** Bound attacker-controlled in-memory state even when source IPs rotate. */
export function evictOldest<T>(entries: Map<string, T>, maximum: number) {
  while (entries.size >= maximum) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) return;
    entries.delete(oldest);
  }
}

export function consumeRateLimit(buckets: Map<string, { count: number; resetAt: number }>, key: string) {
  const now = Date.now();
  for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= LOGIN_RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  bucket.count += 1;
  return true;
}