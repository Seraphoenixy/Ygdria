/**
 * The stable identity this installation reports to a sync server.
 *
 * The server keys a sync peer by `device id + peerId`, so it needs a value that
 * survives reloads. Without one, every request would look like a brand new peer
 * and the server could never tell an active device from an abandoned one — the
 * cursor would never advance, the change log would never be pruned, and
 * tombstones would accumulate forever.
 *
 * The value is opaque and local-only: it is a random identifier, never derived
 * from user content, and it is never sent anywhere except as the peer key of
 * the server this device already authenticated against.
 */
const LOCAL_SYNC_PEER_ID_KEY = "ygdria.sync.localPeerId";

/** Fallback for private-mode / storage-denied browsers: keep the identity for
 * the lifetime of the page so at least a single session stays coherent. */
let inMemoryPeerId: string | undefined;

function randomPeerId() {
  // crypto.randomUUID is unavailable in insecure contexts (plain-http LAN
  // installs), so fall back to getRandomValues and finally to Math.random.
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function localSyncPeerId(): string {
  try {
    const stored = window.localStorage.getItem(LOCAL_SYNC_PEER_ID_KEY);
    if (stored) return stored;
    const generated = inMemoryPeerId ?? randomPeerId();
    window.localStorage.setItem(LOCAL_SYNC_PEER_ID_KEY, generated);
    inMemoryPeerId = generated;
    return generated;
  } catch {
    inMemoryPeerId ??= randomPeerId();
    return inMemoryPeerId;
  }
}

/** True when the server refused an incremental sync because this peer went
 * silent long enough for its cursor to be dropped, and must rebuild from the
 * full snapshot before it is allowed to resume. */
export function isRebaselineRequiredError(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === code) return true;
  // Desktop proxies and older transports may only preserve the message text.
  return error instanceof Error && error.message.includes(code);
}
