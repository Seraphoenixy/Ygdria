import type { NoteContent } from "@ygdria/shared";

/** A sync change the server rejected because last-write-wins kept a newer
 * local version. Surfaced so clients can flag a divergence to the user. */
export type RejectedSyncChange = {
  entityType: string;
  entityId: string;
  localUpdatedAt: number;
  localVersion: number;
};

/**
 * Build an AbortSignal that rejects after `timeoutMs`. Used so startup probes
 * (health / currentDevice) can never hang forever on a slow or unreachable
 * remote server — without a timeout a mobile WebView could sit on the loading
 * screen indefinitely. Returns `undefined` when timeouts are unsupported.
 */
function createTimeoutSignal(timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs) return undefined;
  if (
    typeof AbortSignal === "undefined" ||
    typeof (AbortSignal as { timeout?: unknown }).timeout !== "function"
  ) {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

export class YgdriaClient {
  constructor(
    private baseUrl = "http://127.0.0.1:4318",
    private token?: string,
    private deviceToken?: string,
  ) {}
  setDeviceToken(deviceToken?: string) {
    this.deviceToken = deviceToken;
  }
  getDeviceToken() {
    return this.deviceToken;
  }
  getServerUrl() {
    return this.baseUrl;
  }
  setServerUrl(url: string) {
    this.baseUrl = url;
  }
  peerId() {
    return this.baseUrl;
  }
  private async request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const headers: Record<string, string> = {
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.token) headers["X-Ygdria-Local-Token"] = this.token;
    if (this.deviceToken) headers["Authorization"] = `Bearer ${this.deviceToken}`;
    // Honor a caller-supplied signal; otherwise apply a short timeout so a
    // startup probe can never hang forever on a slow or unreachable server.
    const signal = init?.signal ?? createTimeoutSignal(timeoutMs);
    let r: Response;
    try {
      r = await fetch(this.baseUrl + path, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const requestError = new Error(
        `HTTP 请求失败（${init?.method ?? "GET"} ${this.baseUrl}${path}）：${reason}`,
        { cause: error },
      );
      // Keep abort/timeout semantics available to callers while retaining the
      // request context in the human-readable message.
      if (error instanceof Error) requestError.name = error.name;
      throw requestError;
    }
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const error = new Error(body?.error?.message ?? r.statusText);
      // Surface the server's structured error so callers can detect conflicts
      // (code "ConflictError" / status 409) instead of matching message text.
      (error as Error & { statusCode?: number; code?: string }).statusCode = r.status;
      (error as Error & { statusCode?: number; code?: string }).code = body?.error?.code;
      throw error;
    }
    if (r.status === 204) return undefined as T;
    const contentType = r.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        `API 未返回 JSON（${r.status} ${r.statusText}，Content-Type: ${contentType || "unknown"}）。请检查服务地址是否指向 Ygdria 服务。`,
      );
    }
    return r.json();
  }
  private async requestBinary(path: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) headers["X-Ygdria-Local-Token"] = this.token;
    if (this.deviceToken) headers["Authorization"] = `Bearer ${this.deviceToken}`;
    return fetch(this.baseUrl + path, { headers });
  }
  tree() {
    return this.request<any[]>("/api/v1/tree");
  }
  getNote(id: string) {
    return this.request<any>(`/api/v1/notes/${id}`);
  }
  placementSize(id: string) {
    return this.request<{
      note: {
        contentBytes: number;
        storedContentBytes: number;
        attachmentBytes: number;
        totalBytes: number;
        storedTotalBytes: number;
      };
      subtree: {
        noteCount: number;
        contentBytes: number;
        storedContentBytes: number;
        attachmentBytes: number;
        totalBytes: number;
        storedTotalBytes: number;
      };
    }>(`/api/v1/placements/${id}/size`);
  }
  createNote(body: {
    title: string;
    parentPlacementId?: string | null;
    type?: "text" | "code";
    content?: NoteContent;
    code?: string;
  }) {
    return this.request<any>("/api/v1/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  createTodayNote(body: { title: string; content?: NoteContent }) {
    return this.request<any>("/api/v1/notes/today", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  /**
   * Incremental sync: return all changes since the given cursor.
   * Metadata-only mode is opt-in so existing consumers retain the complete
   * snapshot contract. New sync flows should request metadata-only batches.
   */
  syncChanges(cursor = 0, limit = 200, maxBytes = 4 * 1024 * 1024, metadataOnly = false) {
    return this.request<{
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
    }>(`/api/v1/sync/changes?cursor=${cursor}&limit=${limit}&maxBytes=${maxBytes}${metadataOnly ? "&metadataOnly=1" : ""}`);
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
    syncOrigin?: "remote",
  ) {
    const json = JSON.stringify({ changes });
    let body: BodyInit = json;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(syncOrigin ? { "X-Ygdria-Sync-Origin": syncOrigin } : {}),
    };
    if (typeof CompressionStream !== "undefined" && json.length >= 1024) {
      body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
      headers["Content-Type"] = "application/vnd.ygdria.sync+json";
      headers["Content-Encoding"] = "gzip";
    }
    return this.request<{ applied: number; rejected: RejectedSyncChange[] }>("/api/v1/sync/push", {
      method: "POST",
      headers,
      body,
    });
  }
  /**
   * Advance a peer's sync cursor. After the client has confirmed it has
   * downloaded all attachments referenced by changes up to cursorId, it
   * calls this to advance the cursor. On interruption, the client can
   * restart from the last advanced cursor.
   */
  advanceSyncCursor(peerId: string, cursor: number) {
    return this.request<{ peerId: string; lastAdvanceId: number; advancedAt: number }>(
      "/api/v1/sync/advance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId, cursor }),
      },
    );
  }
  /** Get a peer's sync cursor state. */
  getSyncCursor(peerId: string) {
    return this.request<{ peerId: string; lastAdvanceId: number; advancedAt: number | null }>(
      `/api/v1/sync/cursor?peerId=${encodeURIComponent(peerId)}`,
    );
  }
  syncSnapshot(cursor = 0, limit = 200, metadataOnly = false) {
    return this.request<{
      cursor: number; hasMore: boolean; maxChangeId: number;
      changes: Array<{ changeId: number; entityType: string; entityId: string; changeKind: string; createdAt: number; data: Record<string, unknown> | null }>;
    }>(`/api/v1/sync/snapshot?cursor=${cursor}&limit=${limit}${metadataOnly ? "&metadataOnly=1" : ""}`);
  }
  /** Record every current entity as a fresh baseline for a newly initialized peer. */
  rebuildSyncBaseline() {
    return this.request<{ notes: number; placements: number; revisions: number; settings: number }>(
      "/api/v1/sync/rebuild",
      { method: "POST" },
    );
  }
  /** Download an attachment by content hash. Returns the raw binary response. */
  hasAttachmentByHash(hash: string) {
    return this.request<{ exists: boolean; id: string | null }>(
      `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}/exists`,
    );
  }
  async downloadAttachmentByHash(
    hash: string,
  ): Promise<{ blob: Blob; mimeType: string; size: number }> {
    const response = await this.requestBinary(
      `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}`,
    );
    if (!response.ok) throw new Error(`Failed to download attachment: ${response.statusText}`);
    const blob = await response.blob();
    return {
      blob,
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      size: Number(response.headers.get("content-length") ?? blob.size),
    };
  }
  syncNoteContent(noteId: string, contentHash: string) {
    return this.request<{ contentData: string; contentCodec: string; contentSize: number; contentHash: string; plainText: string }>(
      `/api/v1/sync/notes/${encodeURIComponent(noteId)}/content?hash=${encodeURIComponent(contentHash)}`,
    );
  }
  /** Download an attachment addressed by its stable document URL. */
  async downloadAttachment(id: string): Promise<Blob> {
    const response = await this.requestBinary(`/api/v1/attachments/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Failed to download attachment: ${response.statusText}`);
    return response.blob();
  }
  /** Upload an attachment by content hash. The client sends the raw binary content. */
  uploadAttachmentByHash(
    hash: string,
    noteId: string,
    filename: string,
    data: Blob | ArrayBuffer,
    syncOrigin?: "remote",
    attachmentId?: string,
  ) {
    return this.request<{
      id: string;
      url: string;
      filename: string;
      mimeType: string;
      size: number;
      storageKey: string;
      contentHash: string;
      createdAt: string;
      existed: boolean;
    }>(
      `/api/v1/attachments/by-hash/${encodeURIComponent(hash)}?noteId=${encodeURIComponent(noteId)}&filename=${encodeURIComponent(filename)}${attachmentId ? `&attachmentId=${encodeURIComponent(attachmentId)}` : ""}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          ...(syncOrigin ? { "X-Ygdria-Sync-Origin": syncOrigin } : {}),
        },
        body: data,
      },
    );
  }
  ensureTodayNote() {
    return this.request<any>("/api/v1/notes/today/ensure", { method: "POST" });
  }
  updateNote(
    id: string,
    body: {
      title?: string;
      type?: "text" | "code";
      content?: NoteContent;
      code?: string;
      codeLanguage?: string;
      contentCiphertext?: string;
      revisionIntervalMs?: number;
      expectedVersion: number;
    },
  ) {
    return this.request<any>(`/api/v1/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  archiveNote(id: string, archived: boolean): Promise<{ archivedCount: number }> {
    return this.request<{ archivedCount: number }>(`/api/v1/notes/${id}/archive`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
  }
  archived() {
    return this.request<
      Array<{ id: string; title: string; archivedAt: number; updatedAt: string }>
    >("/api/v1/archived");
  }
  revisions(id: string) {
    return this.request<Array<{ id: string; contentHash: string; createdAt: string }>>(
      `/api/v1/notes/${id}/revisions`,
    );
  }
  restoreRevision(id: string, revisionId: string, expectedVersion: number) {
    return this.request<any>(`/api/v1/notes/${id}/revisions/${revisionId}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion }),
    });
  }
  deleteNote(id: string) {
    return this.request<{ undoId: string }>(`/api/v1/notes/${id}`, { method: "DELETE" });
  }
  getTrashedNote(id: string) {
    return this.request<any>(`/api/v1/trash/${id}`);
  }
  restoreNote(id: string) {
    return this.request<{ undoId: string }>(`/api/v1/notes/${id}/restore`, { method: "POST" });
  }
  purgeNote(id: string) {
    return this.request<{ attachmentStorageKeys: string[] }>(`/api/v1/notes/${id}/permanent`, {
      method: "DELETE",
    });
  }
  purgeTrash(before?: number) {
    const query = before === undefined ? "" : `?before=${encodeURIComponent(String(before))}`;
    return this.request<{ count: number; attachmentStorageKeys: string[] }>(
      `/api/v1/trash${query}`,
      {
        method: "DELETE",
      },
    );
  }
  clonePlacement(noteId: string, parentPlacementId: string) {
    return this.request<any>("/api/v1/placements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, parentPlacementId }),
    });
  }
  movePlacement(id: string, parentPlacementId: string, position: number) {
    return this.request<{ ok: true }>(`/api/v1/placements/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentPlacementId, position }),
    });
  }
  movePlacements(placementIds: string[], parentPlacementId: string, position: number) {
    return this.request<{ ok: true }>("/api/v1/placements", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placementIds, parentPlacementId, position }),
    });
  }
  content(id: string, format: "markdown" | "json" = "markdown") {
    return this.request<any>(`/etapi/notes/${id}/content?format=${format}`);
  }
  putMarkdown(id: string, markdown: string, expectedVersion: number, importMode = false) {
    return this.request<any>(`/etapi/notes/${id}/content`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": String(expectedVersion), ...(importMode ? { "X-Ygdria-Import": "1" } : {}) },
      body: markdown,
    });
  }
  unusedAttachmentsCount() {
    return this.request<{ count: number }>("/api/v1/attachments/unused/count");
  }
  listAttachments() {
    return this.request<{
      attachments: Array<{
        id: string;
        filename: string;
        mimeType: string;
        size: number;
        createdAt: string;
        contentHash: string;
        referencingNotes: Array<{ id: string; title: string }>;
      }>;
      unusedCount: number;
    }>("/api/v1/attachments");
  }
  clearUnusedAttachments(before?: number) {
    const query = before === undefined ? "" : `?before=${encodeURIComponent(String(before))}`;
    return this.request<{ count: number; attachmentStorageKeys: string[] }>(
      `/api/v1/attachments/unused${query}`,
      {
        method: "DELETE",
      },
    );
  }
  setProtected(
    id: string,
    payload:
      | { protected: true; contentCiphertext: string }
      | { protected: false; title: string; content: any; propertiesJson?: string },
  ) {
    return this.request<any>(`/api/v1/notes/${id}/protected`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  protectedSession() {
    return this.request<{
      configured: boolean;
      salt: string | null;
      verifier: string | null;
      timeoutMs: number;
    }>("/api/v1/protected-session");
  }
  setupProtectedSession(
    salt: string,
    verifier: string,
    timeoutMs?: number,
    auth?: { accessSalt: string; srpSalt: string; verifier: string },
  ) {
    return this.request<{ configured: boolean }>("/api/v1/protected-session/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ salt, verifier, timeoutMs, auth }),
    });
  }
  changeProtectedPassword(
    salt: string,
    verifier: string,
    timeoutMs: number,
    notes: Array<{ id: string; contentCiphertext: string; expectedVersion: number }>,
    auth?: { accessSalt: string; srpSalt: string; verifier: string },
    reauthToken?: string,
  ) {
    return this.request<{ configured: boolean; changedNotes: number; authReplaced: boolean }>(
      "/api/v1/protected-session/change-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salt, verifier, timeoutMs, notes, auth, reauthToken }),
      },
    );
  }
  clearProtectedSession(reauthToken?: string) {
    return this.request<{ configured: boolean }>("/api/v1/protected-session/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reauthToken }),
    });
  }
  setProtectedSessionTimeout(timeoutMs: number) {
    return this.request<{ timeoutMs: number }>("/api/v1/protected-session", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutMs }),
    });
  }
  maintainDatabase() {
    return this.request<{ id: string }>("/api/v1/maintenance/database", { method: "POST" });
  }
  listRelations(noteId: string) {
    return this.request<{
      outgoing: Array<{
        id: string;
        sourceNoteId: string;
        targetNoteId: string;
        relationType: string;
        createdAt: number;
        peerTitle: string;
      }>;
      incoming: Array<{
        id: string;
        sourceNoteId: string;
        targetNoteId: string;
        relationType: string;
        createdAt: number;
        peerTitle: string;
      }>;
    }>("/api/v1/relations?noteId=" + encodeURIComponent(noteId), { method: "GET" });
  }
  createRelation(sourceNoteId: string, targetNoteId: string, relationType: string) {
    return this.request<{
      id: string;
      sourceNoteId: string;
      targetNoteId: string;
      relationType: string;
      createdAt: number;
      duplicate: boolean;
    }>("/api/v1/relations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceNoteId, targetNoteId, relationType }),
    });
  }
  deleteRelation(id: string) {
    return this.request<{ deleted: boolean }>(
      "/api/v1/relations/" + encodeURIComponent(id),
      { method: "DELETE" },
    );
  }
  /** Start a maintenance task with optional FTS rebuild. */
  maintainDatabaseWithFts(rebuildFts = false) {
    return this.request<{ id: string }>(`/api/v1/maintenance/database?rebuildFts=${rebuildFts}`, {
      method: "POST",
    });
  }
  clearExcessRevisions(limit: number) {
    return this.request<{ count: number }>("/api/v1/revisions/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    });
  }
  revisionContent(id: string, revisionId: string) {
    return this.request<{ content: NoteContent | string }>(
      `/api/v1/notes/${id}/revisions/${revisionId}`,
    );
  }
  /** Rebuild only the derived full-text index without running VACUUM. */
  rebuildSearchIndex() {
    return this.request<{ id: string }>("/api/v1/maintenance/search-index", { method: "POST" });
  }
  /** Query the current or last maintenance task status. */
  maintenanceStatus() {
    return this.request<{
      task: {
        id: string;
        status: "queued" | "running" | "succeeded" | "failed";
        startedAt: number | null;
        completedAt: number | null;
        errorSummary: string | null;
        result: Record<string, unknown> | null;
      } | null;
    }>("/api/v1/maintenance/status");
  }
  deletePlacement(id: string) {
    return this.request<{ undoId: string }>(`/api/v1/placements/${id}`, { method: "DELETE" });
  }
  undoPlacementDeletion(undoId: string) {
    return this.request<{ undoId: string }>(`/api/v1/placement-deletions/${undoId}/undo`, {
      method: "POST",
    });
  }
  search(q: string, includeArchived = false) {
    return this.request<any[]>(
      `/api/v1/search?q=${encodeURIComponent(q)}&includeArchived=${includeArchived}`,
    );
  }
  history(limit = 200, includeArchived = false) {
    return this.request<
      Array<{ id: string; title: string; path: string[]; updatedAt: string; isTrashed: boolean }>
    >(`/api/v1/history?limit=${limit}&includeArchived=${includeArchived}`);
  }
  // --- Unified master-password authentication (SRP-6a) ---
  health() {
    return this.request<{
      status: string;
      bootstrapped: boolean;
      requiresDeviceAuth: boolean;
      authInitialized: boolean;
    }>("/api/v1/health", undefined, 8000);
  }
  /** Readiness probe: returns 200 when the server is fully operational. */
  ready() {
    return this.request<{ status: string; errors?: string[] }>("/api/v1/ready");
  }
  /** Public auth configuration: protocol/KDF versions and (when initialized)
   *  the salts needed by the client to derive accessSecret. No verifier or
   *  sensitive material is ever returned. */
  authConfig() {
    return this.request<{
      initialized: boolean;
      protocolVersion: string;
      kdfVersion: string;
      pbkdf2Iterations: number;
      accessSalt?: string;
      srpSalt?: string;
      accessSecretContext: string;
      srpUsername: string;
    }>("/api/v1/auth/config");
  }
  /** First-time initialization: submit the SRP registration record (accessSalt,
   *  srpSalt, verifier) AND the file-key material (fileSalt, fileVerifier),
   *  both derived locally from the SAME master password. The server writes them
   *  in one atomic transaction so the file password and the service-access
   *  password can never diverge. Never sends the password, accessSecret,
   *  fileKey, or any static hash. Returns the first device token. Can only
   *  succeed once; a second attempt returns 409. */
  initializeMasterPassword(
    accessSalt: string,
    srpSalt: string,
    verifier: string,
    fileSalt: string,
    fileVerifier: string,
    label: string,
  ) {
    return this.request<{ deviceId: string; deviceToken: string }>("/api/v1/devices/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessSalt, srpSalt, verifier, fileSalt, fileVerifier, label }),
    });
  }
  /** SRP login step 1: send the client public ephemeral, receive a one-time
   *  challenge (challengeId + server public ephemeral) and the SRP salt. */
  srpLoginChallenge(clientPublicEphemeral: string) {
    return this.request<{ challengeId: string; srpSalt: string; serverPublicEphemeral: string }>(
      "/api/v1/auth/login/challenge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientPublicEphemeral }),
      },
    );
  }
  /** SRP login step 2: submit the one-time client proof. On success the server
   *  returns its proof (which the client MUST verify for mutual auth) and a
   *  freshly issued device token. The challenge is consumed regardless. */
  srpLoginVerify(
    challengeId: string,
    clientPublicEphemeral: string,
    clientSessionProof: string,
    label: string,
  ) {
    return this.request<{
      deviceId: string;
      deviceToken: string;
      serverSessionProof: string;
      reauthToken: string;
    }>("/api/v1/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, clientPublicEphemeral, clientSessionProof, label }),
    });
  }
  pair(pairingToken: string, label: string) {
    return this.request<{ deviceId: string; deviceToken: string }>("/api/v1/devices/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, label }),
    });
  }
  listDevices() {
    return this.request<
      Array<{ id: string; label: string; createdAt: number; lastActiveAt: number | null }>
    >("/api/v1/devices");
  }
  currentDevice() {
    return this.request<{
      id: string;
      label: string;
      createdAt: number;
      lastActiveAt: number | null;
    }>("/api/v1/devices/me", undefined, 8000);
  }
  createPairingToken(ttlMs?: number) {
    return this.request<{ pairingToken: string; expiresAt: number }>(
      "/api/v1/devices/pairing-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlMs }),
      },
    );
  }
  revokeDevice(id: string) {
    return this.request<{ revoked: string }>(`/api/v1/devices/${id}`, { method: "DELETE" });
  }
  revokeAllDevices() {
    return this.request<{ revoked: number }>("/api/v1/devices/revoke-all", { method: "POST" });
  }
}
