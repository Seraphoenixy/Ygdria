import { t, type Locale } from "../lib/i18n";
import type { RejectedSyncChange } from "@ygdria/api-client";

type RemoteResponse = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  isBinary: boolean;
};

const REMOTE_GET_RETRY_DELAYS_MS = [250, 750];

function isRetryableTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network error|econnreset|econnrefused|eai_again|enotfound|etimedout|connect timeout|socket hang up/i.test(message);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Desktop Electron proxy client: routes all remote requests through the main
 * process IPC. The deviceToken is held by the main process and NEVER enters
 * the renderer. The main process enforces the HTTPS origin allowlist,
 * disables redirects, and intercepts tokens from auth responses.
 *
 * In browser mode (no `window.ygdria.remote`), the renderer falls back to a
 * direct `YgdriaClient` — the browser page is same-origin with the server, so
 * CSP `connect-src 'self'` permits the request and the token stays in
 * sessionStorage.
 */
export class RemoteProxyClient {
  private serverUrl: string;
  private locale: Locale;
  constructor(serverUrl: string, locale: Locale) {
    this.serverUrl = serverUrl;
    this.locale = locale;
  }
  peerId() {
    return this.serverUrl;
  }
  setDeviceToken(_: string | undefined) {
    /* no-op: main process holds the token */
  }

  private async request(
    path: string,
    init?: { method?: string; body?: string | ArrayBuffer; headers?: Record<string, string> },
  ): Promise<unknown> {
    const method = init?.method ?? "GET";
    let response: RemoteResponse;
    try {
      response = await (async () => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await window.ygdria!.remote!.request({ method, path, body: init?.body, headers: init?.headers });
          } catch (error) {
            if (
              method !== "GET" ||
              attempt >= REMOTE_GET_RETRY_DELAYS_MS.length ||
              !isRetryableTransportError(error)
            )
              throw error;
            await delay(REMOTE_GET_RETRY_DELAYS_MS[attempt]);
          }
        }
      })();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(t(this.locale, "remoteProxyRequestFailed", { method, path, reason }));
    }
    if (response.status >= 400) {
      const body = response.body as { error?: { code?: string; message?: string } } | string | null;
      const message =
        typeof body === "object" && body?.error?.message
          ? body.error.message
          : typeof body === "string" && body
            ? body
            : `HTTP ${response.status}`;
      const error = new Error(`${message}（${method} ${path}）`);
      const code = typeof body === "object" ? body?.error?.code : undefined;
      if (code) (error as Error & { code?: string }).code = code;
      throw error;
    }
    return response.body;
  }

  health() {
    return this.request("/api/v1/health") as Promise<{
      status: string;
      bootstrapped: boolean;
      requiresDeviceAuth: boolean;
      authInitialized: boolean;
    }>;
  }
  authConfig() {
    return this.request("/api/v1/auth/config") as Promise<{
      initialized: boolean;
      protocolVersion: string;
      kdfVersion: string;
      pbkdf2Iterations: number;
      accessSalt?: string;
      srpSalt?: string;
      accessSecretContext: string;
      srpUsername: string;
    }>;
  }
  initializeMasterPassword(
    accessSalt: string,
    srpSalt: string,
    verifier: string,
    fileSalt: string,
    fileVerifier: string,
    label: string,
  ) {
    return this.request("/api/v1/devices/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessSalt, srpSalt, verifier, fileSalt, fileVerifier, label }),
    }) as Promise<{ deviceId: string; deviceToken?: string }>;
  }
  srpLoginChallenge(clientPublicEphemeral: string) {
    return this.request("/api/v1/auth/login/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientPublicEphemeral }),
    }) as Promise<{ challengeId: string; srpSalt: string; serverPublicEphemeral: string }>;
  }
  srpLoginVerify(
    challengeId: string,
    clientPublicEphemeral: string,
    clientSessionProof: string,
    label: string,
  ) {
    return this.request("/api/v1/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, clientPublicEphemeral, clientSessionProof, label }),
    }) as Promise<{
      deviceId: string;
      deviceToken?: string;
      serverSessionProof: string;
      reauthToken: string;
    }>;
  }
  syncChanges(cursor = 0, limit = 200, maxBytes = 4 * 1024 * 1024, metadataOnly = false, peerId?: string) {
    const peer = peerId ? `&peerId=${encodeURIComponent(peerId)}` : "";
    return this.request(`/api/v1/sync/changes?cursor=${cursor}&limit=${limit}&maxBytes=${maxBytes}${metadataOnly ? "&metadataOnly=1" : ""}${peer}`) as Promise<{
      cursor: number;
      hasMore: boolean;
      changes: Array<{
        changeId: number;
        entityType: string;
        entityId: string;
        changeKind: string;
        createdAt: number;
        data: Record<string, unknown> | null;
      }>;
      maxChangeId: number;
      stats?: { serializedBytes: number; returnedEntities: number; coalescedChanges: number };
    }>;
  }
  syncSnapshot(cursor = 0, limit = 200, metadataOnly = false, peerId?: string) {
    const peer = peerId ? `&peerId=${encodeURIComponent(peerId)}` : "";
    return this.request(`/api/v1/sync/snapshot?cursor=${cursor}&limit=${limit}${metadataOnly ? "&metadataOnly=1" : ""}${peer}`) as Promise<{
      cursor: number; hasMore: boolean; maxChangeId: number;
      changes: Array<{ changeId: number; entityType: string; entityId: string; changeKind: string; createdAt: number; data: Record<string, unknown> | null }>;
    }>;
  }
  async pushSyncChanges(
    changes: Array<{
      changeId: number;
      entityType: string;
      entityId: string;
      changeKind: string;
      createdAt: number;
      data: Record<string, unknown> | null;
    }>,
    _syncOrigin?: "remote",
    peerId?: string,
  ) {
    const json = JSON.stringify(peerId ? { changes, peerId } : { changes });
    let body: string | ArrayBuffer = json;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (typeof CompressionStream !== "undefined" && json.length >= 1024) {
      body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
      headers["Content-Type"] = "application/vnd.ygdria.sync+json";
      headers["Content-Encoding"] = "gzip";
    }
    return this.request("/api/v1/sync/push", {
      method: "POST",
      headers,
      body,
    }) as Promise<{ applied: number; rejected: RejectedSyncChange[] }>;
  }
  getNote(id: string) {
    return this.request(`/api/v1/notes/${encodeURIComponent(id)}`) as Promise<any>;
  }
  syncNoteContent(noteId: string, contentHash: string) {
    return this.request(`/api/v1/sync/notes/${encodeURIComponent(noteId)}/content?hash=${encodeURIComponent(contentHash)}`) as Promise<{ contentData: string; contentCodec: string; contentSize: number; contentHash: string; plainText: string }>;
  }
  advanceSyncCursor(peerId: string, cursor: number) {
    return this.request("/api/v1/sync/advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId, cursor }),
    }) as Promise<{ peerId: string; lastAdvanceId: number; advancedAt: number }>;
  }
  getSyncCursor(peerId: string) {
    return this.request(`/api/v1/sync/cursor?peerId=${encodeURIComponent(peerId)}`) as Promise<{
      peerId: string;
      lastAdvanceId: number;
      advancedAt: number | null;
    }>;
  }
  hasAttachmentByHash(hash: string) {
    return this.request(`/api/v1/attachments/by-hash/${encodeURIComponent(hash)}/exists`) as Promise<{ exists: boolean; id: string | null }>;
  }
  async downloadAttachmentByHash(hash: string) {
    const response: RemoteResponse = await window.ygdria!.remote!.request({
      method: "GET",
      path: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}`,
    });
    if (response.status >= 400) {
      const body = response.body as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    }
    const blob = new Blob([response.body as ArrayBuffer]);
    return {
      blob,
      mimeType: response.headers["content-type"] ?? "application/octet-stream",
      size: Number(response.headers["content-length"] ?? (response.body as ArrayBuffer).byteLength),
    };
  }
  async uploadAttachmentByHash(
    hash: string,
    noteId: string,
    filename: string,
    data: Blob | ArrayBuffer,
    syncOrigin?: "remote",
    attachmentId?: string,
  ) {
    const body = data instanceof Blob ? await data.arrayBuffer() : data;
    const response: RemoteResponse = await window.ygdria!.remote!.request({
      method: "POST",
      path: `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}?noteId=${encodeURIComponent(noteId)}&filename=${encodeURIComponent(filename)}${attachmentId ? `&attachmentId=${encodeURIComponent(attachmentId)}` : ""}`,
      body,
      headers: {
        "Content-Type": "application/octet-stream",
        ...(syncOrigin ? { "X-Ygdria-Sync-Origin": syncOrigin } : {}),
      },
    });
    if (response.status >= 400) {
      const errBody = response.body as { error?: { message?: string } } | null;
      throw new Error(errBody?.error?.message ?? `HTTP ${response.status}`);
    }
    return response.body as {
      id: string;
      url: string;
      filename: string;
      mimeType: string;
      size: number;
      storageKey: string;
      contentHash: string;
      createdAt: string;
      existed: boolean;
    };
  }
}
