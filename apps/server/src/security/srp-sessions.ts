import { SRP_LOGIN_TTL_MS, MAX_SECURITY_STATE_RECORDS } from "../http/errors.js";
import { evictOldest } from "./rate-limit.js";

export function pruneExpiredSrpSessions(
  sessions: Map<string, { serverSecretEphemeral: string; expiresAt: number }>,
) {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

export function pruneExpiredReauthTokens(tokens: Map<string, number>) {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) if (expiresAt <= now) tokens.delete(token);
}

export function validPeerId(peerId: unknown): peerId is string {
  return typeof peerId === "string" && peerId.length > 0 && peerId.length <= 2048;
}

export function cursorKey(deviceId: string | undefined, peerId: string) {
  return deviceId ? `device:${deviceId}:peer:${peerId}` : peerId;
}

export { evictOldest } from "./rate-limit.js";