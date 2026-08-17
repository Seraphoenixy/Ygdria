import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { YgdriaClient, RejectedSyncChange } from "@ygdria/api-client";
import { YgdriaClient as YgdriaClientClass } from "@ygdria/api-client";
import { RemoteProxyClient } from "../app/RemoteProxyClient";
import type { Locale } from "../lib/i18n";
import { t } from "../lib/i18n";
import { loadRemoteCredential, saveRemoteCredential } from "../lib/credentialStorage";
import { readSettings } from "../features/settings/settingsStore";
import { SYNC_REBASELINE_REQUIRED } from "@ygdria/shared";
import { localSyncPeerId, isRebaselineRequiredError } from "../lib/syncIdentity";
import {
  assertAuthConfigSupported,
  deriveAccessSecret,
  generateSaltB64,
  srpBeginLogin,
  srpDeriveClientSession,
  srpRegister,
  srpVerifyServer,
} from "../lib/client-crypto";

/** Subset of YgdriaClient needed for attachment transfer in sync. */
type AttachmentTransferClient = Pick<
  YgdriaClient,
  "hasAttachmentByHash" | "downloadAttachmentByHash" | "uploadAttachmentByHash" | "syncNoteContent" | "syncNoteContentBatch"
>;

/** A note whose local edit was rejected by last-write-wins during sync, so the
 * peer's version won. Captured so the user can consciously choose which side
 * to keep instead of silently losing the losing edit. */
export type SyncConflict = {
  noteId: string;
  peerId: string;
  detectedAt: number;
  title: string;
  noteType: "text" | "code";
  isProtected: boolean;
  mineContent: unknown;
  mineVersion: number;
  mineUpdatedAt: number;
  theirsUpdatedAt: number;
  theirsVersion: number;
};

const DESKTOP_ONBOARDING_COMPLETE_KEY = "ygdria.desktop-onboarding-complete";

/** Map in input order while keeping remote sync hydration within a small,
 * bounded connection pool. A snapshot may contain 500 note metadata records;
 * fetching all bodies at once can reset sockets in Electron or a reverse proxy. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

export function isInvalidDeviceToken(error: unknown) {
  // Desktop requests are wrapped by RemoteProxyClient with the request method
  // and path (for example: "Invalid device token（GET /api/v1/sync/changes…）").
  // A 403 can be returned by a proxy or WAF and must never be mistaken for a
  // stale device credential.  Preserve the explicit server wording as a
  // backwards-compatible fallback for older IPC transports that did not
  // expose statusCode.
  if (!(error instanceof Error)) return false;
  const statusCode = (error as Error & { statusCode?: unknown }).statusCode;
  return statusCode === 401 || /invalid device token/i.test(error.message);
}

function formatSyncBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

type UseSyncOptions = {
  client: YgdriaClient;
  locale: Locale;
  refreshTree: () => void;
  openSettings: () => void;
  deviceAccess: string;
  session: {
    setup: (password: string) => Promise<void>;
    unlock: (password: string, salt: string, verifier: string) => Promise<void>;
    lock: () => void;
    salt: string | null;
    verifier: string | null;
    timeoutMs: number;
  };
  setProtectedSession: (
    updater: (current: { configured: boolean; unlocked: boolean; timeoutMs: number }) => {
      configured: boolean;
      unlocked: boolean;
      timeoutMs: number;
    },
  ) => void;
  showToast: (message: string) => void;
  isDesktopApp: boolean;
  /** Whether the user is currently editing a note. Auto-sync is suppressed while true. */
  editing: boolean;
};

export type AutoSyncOptions = {
  state: "unconfigured" | "synced" | "pending";
  editing: boolean;
  syncing: boolean;
  syncConflictsLen: number;
  remoteReauthRequired: boolean;
  remoteClientAvailable: boolean;
  isDesktop: boolean;
  syncLocked: boolean;
};

export type ProtectedSessionConfig = {
  configured: boolean;
  salt: string | null;
  verifier: string | null;
  timeoutMs: number;
};

/** Decide how a desktop reconciles its local file-key record with its sync
 * server. The first configured device seeds an empty server; afterwards the
 * server is canonical so every later device uses the same key material. */
export function protectedSessionSyncAction(
  local: ProtectedSessionConfig,
  remote: ProtectedSessionConfig,
): "publish-local" | "adopt-remote" | "aligned" | "unconfigured" {
  const hasLocal = Boolean(local.salt && local.verifier);
  const hasRemote = Boolean(remote.salt && remote.verifier);
  if (!hasRemote) return hasLocal ? "publish-local" : "unconfigured";
  return local.salt === remote.salt && local.verifier === remote.verifier
    ? "aligned"
    : "adopt-remote";
}

/** Returns whether a completed state check may start a desktop auto-sync. */
export function shouldAutoSync(opts: AutoSyncOptions): boolean {
  return opts.state === "pending" &&
    opts.isDesktop &&
    !opts.editing &&
    !opts.syncing &&
    !opts.syncLocked &&
    opts.syncConflictsLen === 0 &&
    !opts.remoteReauthRequired &&
    opts.remoteClientAvailable;
}

function isRetryableSyncTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /remote request failed|remote proxy request failed|fetch failed|failed to fetch|network error|econnreset|econnrefused|eai_again|enotfound|etimedout|connect timeout|timed out|socket hang up/i.test(message);
}

export function useSync({
  client,
  locale,
  refreshTree,
  openSettings,
  deviceAccess,
  session,
  setProtectedSession,
  showToast,
  isDesktopApp,
  editing,
}: UseSyncOptions) {
  // --- Remote client state ---
  const [remoteClient, setRemoteClient] = useState<
    RemoteProxyClient | YgdriaClient | null | undefined
  >(undefined);
  const [desktopOnboarding, setDesktopOnboarding] = useState<"checking" | "required" | "complete">(
    isDesktopApp ? "checking" : "complete",
  );
  const [remoteReauthRequired, setRemoteReauthRequired] = useState(false);
  const remoteAuthEpochRef = useRef(0);
  const remoteReauthInProgressRef = useRef(false);
  const [pendingSyncServerUrl, setPendingSyncServerUrl] = useState<string>();

  // --- Sync state ---
  const [syncState, setSyncState] = useState<"unconfigured" | "synced" | "pending">("unconfigured");
  const [syncProgress, setSyncProgress] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAtByPeer, setLastSyncedAtByPeer] = useState<Record<string, number>>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("ygdria.sync.lastSyncedAt") ?? "{}");
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, number> : {};
    } catch {
      return {};
    }
  });
  const [syncItemCount, setSyncItemCount] = useState<{ out: number; in: number }>({ out: 0, in: 0 });
  const [lastSyncError, setLastSyncError] = useState<string | undefined>();
  const [syncConflictsByPeer, setSyncConflictsByPeer] = useState<Record<string, SyncConflict[]>>(() => {
    try {
      const raw = window.localStorage.getItem("ygdria.sync.conflicts");
      const stored = raw ? JSON.parse(raw) : {};
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, SyncConflict[]> : {};
    } catch {
      return {};
    }
  });
  const activeSyncPeer = remoteClient?.peerId();
  const lastSyncedAt = activeSyncPeer ? lastSyncedAtByPeer[activeSyncPeer] : undefined;
  const syncConflicts = activeSyncPeer ? (syncConflictsByPeer[activeSyncPeer] ?? []) : [];

  // Pending conflicts and last-sync status are scoped to their remote peer so
  // switching servers can never surface or resolve another server's conflict.
  useEffect(() => {
    try {
      window.localStorage.setItem("ygdria.sync.conflicts", JSON.stringify(syncConflictsByPeer));
      window.localStorage.setItem("ygdria.sync.lastSyncedAt", JSON.stringify(lastSyncedAtByPeer));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [syncConflictsByPeer, lastSyncedAtByPeer]);
  const syncEpochRef = useRef(0);
  const [syncAfterBootstrap, setSyncAfterBootstrap] = useState(false);
  // Keep a ref to `editing` so the 15 s interval callback always reads the
  // latest value instead of a stale closure captured at effect creation time.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Refs mirror the corresponding state values so the periodic-check effect
  // can read the latest values without listing them as dependencies (which
  // would re-run the effect and add extra checks beyond the 15 s tick).
  const syncingRef = useRef(syncing);
  syncingRef.current = syncing;
  const syncConflictsRef = useRef(syncConflicts);
  syncConflictsRef.current = syncConflicts;
  const remoteReauthRequiredRef = useRef(remoteReauthRequired);
  remoteReauthRequiredRef.current = remoteReauthRequired;
  const remoteClientRef = useRef(remoteClient);
  remoteClientRef.current = remoteClient;
  // Synchronous lock shared by every sync entry point, including the manual,
  // bootstrap and auto-sync paths.
  const syncLockRef = useRef(false);

  // --- Remote client init ---
  useEffect(() => {
    const load = async () => {
      if (isDesktopApp) {
        const status = await window.ygdria?.remote?.status();
        if (status?.configured && status.serverUrl) {
          setRemoteClient(new RemoteProxyClient(status.serverUrl, locale));
          setDesktopOnboarding("complete");
          return;
        }
        setRemoteClient(null);
        setDesktopOnboarding(
          window.localStorage.getItem(DESKTOP_ONBOARDING_COMPLETE_KEY) === "true"
            ? "complete"
            : "required",
        );
        return;
      }
      try {
        const credential = await loadRemoteCredential();
        const isNative = Capacitor.isNativePlatform();
        // On mobile the authoritative server address is the "目标服务器地址"
        // (syncServerUrl) from settings — not the address auto-saved alongside
        // the device credential. Other platforms keep using the credential's
        // server URL. Fall back to the credential's serverUrl for legacy mobile
        // installs that have not set syncServerUrl yet.
        const targetUrl = isNative
          ? readSettings().syncServerUrl?.trim() || credential?.serverUrl
          : credential?.serverUrl;
        setRemoteClient(
          // A device token is scoped to its issuing server. Never send a
          // credential recovered for one server to a newly configured URL.
          targetUrl && credential?.deviceToken && credential.serverUrl === targetUrl
            ? new YgdriaClientClass(targetUrl, undefined, credential.deviceToken)
            : null,
        );
      } catch {
        setRemoteClient(null);
      }
    };
    void load();
  }, [isDesktopApp]);

  const showSyncComplete = useCallback(() => {
    showToast(t(locale, "syncComplete"));
  }, [locale, showToast]);

  const computeSyncState = useCallback(
    async (peer: string): Promise<"synced" | "pending"> => {
      if (!remoteClient) return "pending";
      const [outgoingCursor, incomingCursor] = await Promise.all([
        client.getSyncCursor(`out:${peer}`),
        client.getSyncCursor(`in:${peer}`),
      ]);
      // Probing the remote under our own peer id doubles as the liveness ping
      // for a device that only ever pulls: a peer that stays caught up never
      // calls /advance, so without this it would eventually look abandoned and
      // be pushed back onto the snapshot baseline for no reason.
      const [outgoing, incoming] = await Promise.all([
        client.syncChanges(outgoingCursor.lastAdvanceId, 1, undefined, true),
        remoteClient
          .syncChanges(incomingCursor.lastAdvanceId, 1, undefined, true, localSyncPeerId())
          .catch((error: unknown) => {
            // Being gated is pending work, not a broken status check: report it
            // as "pending" so the next sync run performs the re-baseline.
            if (isRebaselineRequiredError(error, SYNC_REBASELINE_REQUIRED)) return null;
            throw error;
          }),
      ]);
      return !incoming || outgoing.changes.length || incoming.changes.length ? "pending" : "synced";
    },
    [client, remoteClient],
  );

  const checkSyncState = useCallback(async (): Promise<"unconfigured" | "synced" | "pending"> => {
    if (deviceAccess !== "ready" || !remoteClient) {
      setSyncState("unconfigured");
      return "unconfigured";
    }
    const epoch = syncEpochRef.current;
    const state = await computeSyncState(remoteClient.peerId());
    if (epoch === syncEpochRef.current) setSyncState(state);
    return state;
  }, [computeSyncState, deviceAccess, remoteClient]);

  const syncNow = useCallback(() => {
    if (!remoteClient) {
      openSettings();
      return;
    }
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    const authEpoch = remoteAuthEpochRef.current;
    const syncEpoch = ++syncEpochRef.current;
    setSyncing(true);
    setSyncProgress(t(locale, "syncPreparing"));
    void (async () => {
      // A desktop mirror is a separate SQLite library. Sync deliberately does
      // not replicate protected_session_* settings. The first configured
      // device seeds an empty server; once present, the server record is
      // canonical and is adopted by every device before ciphertext sync.
      if (isDesktopApp) {
        const remoteProtected = await remoteClient.protectedSession();
        const localProtected = await client.protectedSession();
        const action = protectedSessionSyncAction(localProtected, remoteProtected);
        if (action === "publish-local") {
          await remoteClient.setupProtectedSession(
            localProtected.salt!,
            localProtected.verifier!,
            localProtected.timeoutMs,
          );
        } else if (action === "adopt-remote") {
          const differsFromActiveSession =
            session.salt !== remoteProtected.salt || session.verifier !== remoteProtected.verifier;
          if (session.salt !== null && differsFromActiveSession) session.lock();
          await client.setupProtectedSession(
            remoteProtected.salt!,
            remoteProtected.verifier!,
            remoteProtected.timeoutMs,
          );
          setProtectedSession((current) => ({
            configured: true,
            unlocked: differsFromActiveSession ? false : current.unlocked,
            timeoutMs: remoteProtected.timeoutMs,
          }));
        } else if (action === "aligned") {
          // Keep the timeout in sync without changing the active key.
          await client.setupProtectedSession(
            remoteProtected.salt!,
            remoteProtected.verifier!,
            remoteProtected.timeoutMs,
          );
          setProtectedSession((current) => ({
            ...current,
            configured: true,
            timeoutMs: remoteProtected.timeoutMs,
          }));
        }
      }
      const BATCH_CONTENT_CHUNK_SIZE = 80;
      const hydrateNoteContents = async <
        T extends { entityType: string; changeKind: string; data: Record<string, unknown> | null },
      >(
        changes: T[],
        source: AttachmentTransferClient,
        snapshotSession?: string,
      ): Promise<T[]> => {
        // Collect indices of notes that need content hydration
        const pending: Array<{ index: number; id: string; hash: string }> = [];
        for (let i = 0; i < changes.length; i++) {
          const c = changes[i];
          if (
            c.entityType === "note" &&
            c.changeKind !== "deleted" &&
            c.data &&
            typeof c.data.contentHash === "string" &&
            typeof c.data.contentData !== "string"
          )
            pending.push({ index: i, id: String(c.data.id), hash: c.data.contentHash });
        }
        if (pending.length === 0) return changes;

        const result = [...changes] as T[];
        // Process in chunks to stay within server limits and response size bounds
        for (let offset = 0; offset < pending.length; offset += BATCH_CONTENT_CHUNK_SIZE) {
          const chunk = pending.slice(offset, offset + BATCH_CONTENT_CHUNK_SIZE);
          const ids = chunk.map((p) => p.id);
          const hashes = chunk.map((p) => p.hash);
          const batch = await source.syncNoteContentBatch(ids, hashes, snapshotSession);
          for (const entry of chunk) {
            const content = batch.contents[entry.id];
            if (content) {
              result[entry.index] = { ...result[entry.index], data: { ...result[entry.index].data!, ...content } } as T;
            } else if (batch.truncated) {
              // Fall back to individual fetch for truncated entries
              const fallback = await source.syncNoteContent(entry.id, entry.hash);
              result[entry.index] = { ...result[entry.index], data: { ...result[entry.index].data!, ...fallback } } as T;
            }
          }
        }
        return result;
      };
      const ATTACHMENT_TRANSFER_CONCURRENCY = 6;
      const copyAttachments = async (
        changes: Array<{
          entityType: string;
          changeKind: string;
          data: Record<string, unknown> | null;
        }>,
        source: AttachmentTransferClient,
        destination: AttachmentTransferClient,
        destinationOrigin?: "remote",
      ) => {
        // Collect unique attachment references, deduplicating by contentHash
        const refsByHash = new Map<string, { id: string; contentHash: string; filename: string; noteId: string }>();
        for (const change of changes) {
          if (change.entityType !== "note" || change.changeKind === "deleted" || !change.data) continue;
          const noteId = typeof change.data.id === "string" ? change.data.id : undefined;
          if (!noteId) continue;
          const refs = Array.isArray(change.data.attachmentRefs)
            ? (change.data.attachmentRefs as Array<{ id?: string; contentHash?: string; filename?: string }>)
            : [];
          for (const ref of refs) {
            if (!ref.id || !ref.contentHash || !ref.filename) continue;
            // First occurrence wins (preserves reference order)
            if (!refsByHash.has(ref.contentHash)) {
              refsByHash.set(ref.contentHash, { id: ref.id, contentHash: ref.contentHash, filename: ref.filename, noteId });
            }
          }
        }
        const entries = [...refsByHash.values()];
        const total = entries.length;
        if (total === 0) return;

        let completed = 0;
        function updateProgress() {
          completed += 1;
          setSyncProgress(`${t(locale, "syncAttachments")} ${completed}/${total}`);
        }

        // Bounded concurrent pipeline: check existence → download missing → upload
        let nextIndex = 0;
        const workers = Math.min(ATTACHMENT_TRANSFER_CONCURRENCY, total);
        await Promise.all(
          Array.from({ length: workers }, async () => {
            while (nextIndex < total) {
              const index = nextIndex;
              nextIndex += 1;
              const ref = entries[index];

              const existing = await destination.hasAttachmentByHash(ref.contentHash);
              if (existing.exists && existing.id === ref.id) {
                updateProgress();
                continue;
              }

              const file = await source.downloadAttachmentByHash(ref.contentHash);
              await destination.uploadAttachmentByHash(
                ref.contentHash,
                ref.noteId,
                ref.filename,
                file.blob,
                destinationOrigin,
                ref.id,
              );
              updateProgress();
            }
          }),
        );
      };
      const peer = remoteClient.peerId();
      // Notes whose local edit the remote rejected via last-write-wins during
      // this sync. Captured here (before the download phase can overwrite the
      // losing local edit) so the panel can show exactly what was discarded.
      const builtConflicts: SyncConflict[] = [];
      const buildConflict = async (
        rejected: RejectedSyncChange,
        peerId: string,
      ): Promise<SyncConflict> => {
        const base = {
          noteId: rejected.entityId,
          peerId,
          detectedAt: Date.now(),
          theirsUpdatedAt: rejected.localUpdatedAt,
          theirsVersion: rejected.localVersion,
        };
        try {
          const note = await client.getNote(rejected.entityId);
          if (note) {
            const rawUpdatedAt = note.updatedAt;
            const mineUpdatedAt =
              typeof rawUpdatedAt === "string"
                ? new Date(rawUpdatedAt).getTime()
                : Number(rawUpdatedAt) || 0;
            return {
              ...base,
              title: typeof note.title === "string" ? note.title : "",
              noteType: note.type === "code" ? "code" : "text",
              isProtected: Boolean(note.isProtected),
              mineContent: note.isProtected ? null : note.content,
              mineVersion: typeof note.version === "number" ? note.version : 0,
              mineUpdatedAt,
            };
          }
        } catch {
          /* fall through to a metadata-only conflict record */
        }
        return {
          ...base,
          title: "",
          noteType: "text",
          isProtected: false,
          mineContent: null,
          mineVersion: 0,
          mineUpdatedAt: 0,
        };
      };
      // Identity this device reports to the remote. The remote's own key for us
      // is `device token + this id`, which is what lets the server distinguish
      // an active peer from an abandoned one.
      const selfPeer = localSyncPeerId();
      /**
       * Rebuild the local mirror from the remote's full snapshot, then confirm
       * the resulting cursor back to the remote.
       *
       * This serves both the first-run baseline and the recovery path for a
       * peer the server has gated with SYNC_REBASELINE_REQUIRED. The closing
       * cursor confirmation is what lifts that gate and re-registers this
       * device, so it must run even when the snapshot came back empty.
       */
      const rebaselineFromSnapshot = async () => {
        const sessionId = crypto.randomUUID();
        let snapshot = await remoteClient.syncSnapshot(0, 500, true, selfPeer, sessionId);
        while (snapshot.changes.length) {
          setSyncProgress(`${t(locale, "syncDownloadBaseline")} · ${snapshot.changes.length}`);
          const hydrated = await hydrateNoteContents(snapshot.changes, remoteClient, sessionId);
          await client.pushSyncChanges(hydrated, "remote");
          await copyAttachments(snapshot.changes, remoteClient, client, "remote");
          if (!snapshot.hasMore) break;
          snapshot = await remoteClient.syncSnapshot(snapshot.cursor, 500, true, selfPeer, sessionId);
        }
        await client.advanceSyncCursor(`in:${peer}`, snapshot.maxChangeId);
        await remoteClient.advanceSyncCursor(selfPeer, snapshot.maxChangeId);
      };
      const runSyncPass = async () => {
        let incomingCursor = await client.getSyncCursor(`in:${peer}`);
        if (incomingCursor.advancedAt === null) {
          await rebaselineFromSnapshot();
          incomingCursor = await client.getSyncCursor(`in:${peer}`);
        }
        const outgoingCursor = await client.getSyncCursor(`out:${peer}`);
        let outgoing = await client.syncChanges(outgoingCursor.lastAdvanceId, 500, undefined, true);
        while (outgoing.changes.length) {
          setSyncProgress(
            `${t(locale, "syncUploadMeta")} · ${outgoing.changes.length} · ${formatSyncBytes(outgoing.stats?.serializedBytes ?? 0)}`,
          );
          setSyncItemCount((current) => ({ out: outgoing.changes.length, in: current.in }));
          const hydrated = await hydrateNoteContents(outgoing.changes, client);
          const pushResult = await remoteClient.pushSyncChanges(hydrated, undefined, selfPeer);
          for (const rejected of pushResult.rejected) {
            if (rejected.entityType === "note")
              builtConflicts.push(await buildConflict(rejected, peer));
          }
          await copyAttachments(outgoing.changes, client, remoteClient);
          await client.advanceSyncCursor(`out:${peer}`, outgoing.cursor);
          if (!outgoing.hasMore) break;
          outgoing = await client.syncChanges(outgoing.cursor, 500, undefined, true);
        }
        let incoming = await remoteClient.syncChanges(
          incomingCursor.lastAdvanceId,
          500,
          undefined,
          true,
          selfPeer,
        );
        while (incoming.changes.length) {
          setSyncProgress(
            `${t(locale, "syncDownloadMeta")} · ${incoming.changes.length} · ${formatSyncBytes(incoming.stats?.serializedBytes ?? 0)}`,
          );
          setSyncItemCount((current) => ({ out: current.out, in: incoming.changes.length }));
          const hydrated = await hydrateNoteContents(incoming.changes, remoteClient);
          await client.pushSyncChanges(hydrated, "remote");
          await copyAttachments(incoming.changes, remoteClient, client, "remote");
          await client.advanceSyncCursor(`in:${peer}`, incoming.cursor);
          // Mirror the position back to the remote. Without this the server
          // never learns that anyone consumed the batch, so its change log and
          // the tombstones behind it could never be pruned.
          await remoteClient.advanceSyncCursor(selfPeer, incoming.cursor);
          if (!incoming.hasMore) break;
          incoming = await remoteClient.syncChanges(incoming.cursor, 500, undefined, true, selfPeer);
        }
      };
      try {
        await runSyncPass();
      } catch (error) {
        if (!isRebaselineRequiredError(error, SYNC_REBASELINE_REQUIRED)) throw error;
        // The server dropped this device's cursor after a long silence and now
        // refuses incremental traffic from it. Rebuild from the snapshot rather
        // than reporting a failure the user has no way to act on.
        setSyncProgress(t(locale, "syncRebaselining"));
        await rebaselineFromSnapshot();
        await runSyncPass();
      }
      if (builtConflicts.length && syncEpoch === syncEpochRef.current) {
        setSyncConflictsByPeer((current) => {
          const byId = new Map((current[peer] ?? []).map((c) => [c.noteId, c]));
          for (const conflict of builtConflicts) byId.set(conflict.noteId, conflict);
          return { ...current, [peer]: Array.from(byId.values()) };
        });
      }
      await refreshTree();
      const finalState = await computeSyncState(peer);
      if (syncEpoch === syncEpochRef.current) setSyncState(finalState);
      if (syncEpoch === syncEpochRef.current) {
        setLastSyncedAtByPeer((current) => ({ ...current, [peer]: Date.now() }));
        setLastSyncError(undefined);
        setSyncItemCount({ out: 0, in: 0 });
      }
      showSyncComplete();
      setSyncProgress(undefined);
    })()
      .catch((error) => {
        console.error("Immediate sync failed", error);
        const message = error instanceof Error ? error.message : String(error);
        showToast(`${t(locale, "syncFailed")}${message ? `: ${message}` : ""}`);
        setSyncProgress(`${t(locale, "syncFailedRetry")}: ${message}`);
        if (syncEpoch === syncEpochRef.current) {
          setSyncState("pending");
          setLastSyncError(message);
        }
        if (
          isDesktopApp &&
          isInvalidDeviceToken(error) &&
          authEpoch === remoteAuthEpochRef.current &&
          !remoteReauthInProgressRef.current
        )
          setRemoteReauthRequired(true);
        // A transient transport failure is already retried for idempotent GETs
        // and the 15 s scheduler will retry the sync pass. Opening settings
        // here makes a momentary network drop look like a configuration error.
        else if (!isRetryableSyncTransportError(error)) openSettings();
      })
      .finally(() => {
        if (syncEpoch === syncEpochRef.current) {
          setSyncing(false);
          syncLockRef.current = false;
        }
      });
  }, [
    client,
    locale,
    computeSyncState,
    isDesktopApp,
    openSettings,
    refreshTree,
    remoteClient,
    showSyncComplete,
    showToast,
  ]);

  // --- Periodic sync state check + auto-sync (desktop only) ---
  //
  // Runs checkSyncState() every 15 s and on window focus. After the check
  // completes, if all auto-sync preconditions are met, syncNow() is called.
  //
  // Auto-sync preconditions (all must be true):
  //   1. checkSyncState returned "pending"
  //   2. isDesktopApp === true (auto-sync is desktop-only)
  //   3. User is NOT currently editing (editingRef)
  //   4. No sync is already in progress (syncingRef)
  //   5. syncLockRef is not held (prevents concurrent auto-sync calls)
  //   6. No pending sync conflicts (syncConflictsRef)
  //   7. Remote does not require re-authentication (remoteReauthRequiredRef)
  //   8. Remote client is configured and available (remoteClientRef)
  //
  // Effect dependencies are deliberately limited to [checkSyncState, isDesktopApp]
  // so the interval is not restarted or re-triggered by syncing / conflict /
  // reauth state changes. All of those are read via refs at call time.
  //
  // Failure handling: a failed sync sets syncState back to "pending" and the
  // next 15 s tick will retry. Conflicts or auth failures suppress auto-sync
  // until the user resolves them manually.
  useEffect(() => {
    let cancelled = false;
    const refreshSyncState = () => {
      const authEpoch = remoteAuthEpochRef.current;
      void checkSyncState()
        .then((state) => {
          if (cancelled) return;
          if (
            !shouldAutoSync({
              state,
              editing: editingRef.current,
              syncing: syncingRef.current,
              syncConflictsLen: syncConflictsRef.current.length,
              remoteReauthRequired: remoteReauthRequiredRef.current,
              remoteClientAvailable: Boolean(remoteClientRef.current),
              isDesktop: isDesktopApp,
              syncLocked: syncLockRef.current,
            })
          )
            return;
          syncNow();
        })
        .catch((error) => {
          if (!cancelled) {
            console.error("Unable to check sync status", error);
            setSyncState("pending");
            if (
              isDesktopApp &&
              isInvalidDeviceToken(error) &&
              authEpoch === remoteAuthEpochRef.current &&
              !remoteReauthInProgressRef.current
            )
              setRemoteReauthRequired(true);
          }
        });
    };
    refreshSyncState();
    const interval = window.setInterval(refreshSyncState, 15_000);
    window.addEventListener("focus", refreshSyncState);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshSyncState);
    };
  }, [checkSyncState, isDesktopApp]);

  // --- Auto-sync on editing exit (desktop only) ---
  //
  // When the user finishes editing (editing transitions from true to false),
  // immediately run a sync state check. If the check returns "pending" and all
  // auto-sync preconditions are met (same rules as the periodic check above),
  // trigger syncNow() without waiting for the next 15 s tick.
  const prevEditingRef = useRef(editing);
  useEffect(() => {
    const wasEditing = prevEditingRef.current;
    prevEditingRef.current = editing;
    // Only act on the true → false transition, and only on desktop.
    if (!wasEditing || editing || !isDesktopApp) return;
    const authEpoch = remoteAuthEpochRef.current;
    // Immediately check sync state and auto-sync if pending.
    void checkSyncState()
      .then((state) => {
        if (
          !shouldAutoSync({
            state,
            editing: editingRef.current,
            syncing: syncingRef.current,
            syncConflictsLen: syncConflictsRef.current.length,
            remoteReauthRequired: remoteReauthRequiredRef.current,
            remoteClientAvailable: Boolean(remoteClientRef.current),
            isDesktop: isDesktopApp,
            syncLocked: syncLockRef.current,
          })
        )
          return;
        syncNow();
      })
      .catch((error) => {
        console.error("Unable to check sync status on editing exit", error);
        setSyncState("pending");
        if (
          isDesktopApp &&
          isInvalidDeviceToken(error) &&
          authEpoch === remoteAuthEpochRef.current &&
          !remoteReauthInProgressRef.current
        )
          setRemoteReauthRequired(true);
      });
  }, [editing, isDesktopApp, checkSyncState, syncNow]);

  // --- Sync after bootstrap ---
  useEffect(() => {
    if (!syncAfterBootstrap || deviceAccess !== "ready" || !remoteClient) return;
    setSyncAfterBootstrap(false);
    syncNow();
  }, [deviceAccess, remoteClient, syncAfterBootstrap, syncNow]);

  // --- Reauthenticate ---
  const reauthenticateRemote = useCallback(
    async (password: string) => {
      if (!remoteClient) throw new Error(t(locale, "syncNotConfigured"));
      remoteReauthInProgressRef.current = true;
      remoteAuthEpochRef.current += 1;
      const config = await remoteClient.authConfig();
      assertAuthConfigSupported(config);
      if (!config.initialized || !config.accessSalt || !config.srpSalt)
        throw new Error(t(locale, "syncTargetNotInitialized"));
      const accessSecret = await deriveAccessSecret(password, config.accessSalt);
      const clientEphemeral = srpBeginLogin();
      const challenge = await remoteClient.srpLoginChallenge(clientEphemeral.public);
      const clientSession = srpDeriveClientSession(
        clientEphemeral,
        challenge.serverPublicEphemeral,
        challenge.srpSalt,
        accessSecret,
      );
      const credential = await remoteClient.srpLoginVerify(
        challenge.challengeId,
        clientEphemeral.public,
        clientSession.proof,
        t(locale, "deviceLabelDesktop"),
      );
      srpVerifyServer(clientEphemeral, clientSession, credential.serverSessionProof);
      if (credential.deviceToken) {
        (remoteClient as YgdriaClient).setDeviceToken(credential.deviceToken);
        if (!isDesktopApp && pendingSyncServerUrl)
          void saveRemoteCredential({
            serverUrl: pendingSyncServerUrl,
            deviceToken: credential.deviceToken,
          });
      }
      remoteReauthInProgressRef.current = false;
      setRemoteReauthRequired(false);
      setPendingSyncServerUrl(undefined);
      setSyncState("pending");
      syncNow();
    },
    [isDesktopApp, pendingSyncServerUrl, remoteClient, syncNow, locale],
  );

  // --- Migrate to empty server ---
  const migrateToEmptyServer = useCallback(
    async (serverUrl: string, password: string, label: string) => {
      if (!isDesktopApp) throw new Error(t(locale, "desktopOnlyMigration"));
      let target: URL;
      try {
        target = new URL(serverUrl);
      } catch {
        throw new Error(t(locale, "invalidServerUrl"));
      }
      if (target.protocol !== "https:") throw new Error(t(locale, "migrateRequiresHttps"));
      const localProtected = await client.protectedSession();
      if (!localProtected.salt || !localProtected.verifier)
        throw new Error(t(locale, "localProtectedNotConfigured"));
      await session.unlock(password, localProtected.salt, localProtected.verifier);
      await window.ygdria!.remote!.configure(target.origin);
      const remote = new RemoteProxyClient(target.origin, locale);
      const health = await remote.health();
      if (health.authInitialized || health.bootstrapped)
        throw new Error(t(locale, "targetAlreadyInitialized"));

      await client.advanceSyncCursor(`out:${target.origin}`, 0);
      await client.advanceSyncCursor(`in:${target.origin}`, 0);
      await client.rebuildSyncBaseline();

      const accessSalt = generateSaltB64();
      const accessSecret = await deriveAccessSecret(password, accessSalt);
      const registration = srpRegister(accessSecret);
      await remote.initializeMasterPassword(
        accessSalt,
        registration.srpSalt,
        registration.verifier,
        localProtected.salt,
        localProtected.verifier,
        label,
      );
      setRemoteClient(remote);
      setPendingSyncServerUrl(target.origin);
      setProtectedSession((current) => ({ ...current, configured: true, unlocked: true }));
      setRemoteReauthRequired(false);
      setSyncState("pending");
      setSyncAfterBootstrap(true);
    },
    [client, isDesktopApp, session, setProtectedSession, locale],
  );

  const removeSyncConflict = useCallback((noteId: string) => {
    const peer = remoteClient?.peerId();
    if (!peer) return;
    setSyncConflictsByPeer((current) => ({
      ...current,
      [peer]: (current[peer] ?? []).filter((conflict) => conflict.noteId !== noteId),
    }));
  }, [remoteClient]);

  return {
    // Remote client
    remoteClient,
    setRemoteClient,
    desktopOnboarding,
    setDesktopOnboarding,
    remoteReauthRequired,
    setRemoteReauthRequired,
    remoteAuthEpochRef,
    remoteReauthInProgressRef,
    pendingSyncServerUrl,
    setPendingSyncServerUrl,
    reauthenticateRemote,
    migrateToEmptyServer,
    // Sync
    syncState,
    syncProgress,
    syncing,
    lastSyncedAt,
    syncItemCount,
    lastSyncError,
    syncConflicts,
    removeSyncConflict,
    syncEpochRef,
    syncAfterBootstrap,
    setSyncAfterBootstrap,
    syncNow,
    checkSyncState,
    showSyncComplete,
  };
}
