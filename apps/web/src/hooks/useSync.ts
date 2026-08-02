import { useCallback, useEffect, useRef, useState } from "react";
import type { YgdriaClient } from "@ygdria/api-client";
import { YgdriaClient as YgdriaClientClass } from "@ygdria/api-client";
import { RemoteProxyClient } from "../app/RemoteProxyClient";
import type { Locale } from "../lib/i18n";
import { t } from "../lib/i18n";
import { loadRemoteCredential, saveRemoteCredential } from "../lib/credentialStorage";
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
  "hasAttachmentByHash" | "downloadAttachmentByHash" | "uploadAttachmentByHash" | "syncNoteContent"
>;

const DESKTOP_ONBOARDING_COMPLETE_KEY = "ygdria.desktop-onboarding-complete";

function isInvalidDeviceToken(error: unknown) {
  // Desktop requests are wrapped by RemoteProxyClient with the request method
  // and path (for example: "Invalid device token（GET /api/v1/sync/changes…）").
  // Treat all authentication failures as re-authentication candidates instead
  // of requiring the unwrapped server message to match exactly.
  return error instanceof Error && /invalid device token|unauthorized|\bHTTP (?:401|403)\b/i.test(error.message);
}

function formatSyncBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
  setProtectedSession: (updater: (current: { configured: boolean; unlocked: boolean; timeoutMs: number }) => { configured: boolean; unlocked: boolean; timeoutMs: number }) => void;
  showToast: (message: string) => void;
  isDesktopApp: boolean;
};

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
  const syncEpochRef = useRef(0);
  const [syncAfterBootstrap, setSyncAfterBootstrap] = useState(false);

  // --- Remote client init ---
  useEffect(() => {
    const load = async () => {
      if (isDesktopApp) {
        const status = await window.ygdria?.remote?.status();
        if (status?.configured && status.serverUrl) {
          setRemoteClient(new RemoteProxyClient(status.serverUrl));
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
        setRemoteClient(
          credential?.serverUrl && credential.deviceToken
            ? new YgdriaClientClass(credential.serverUrl, undefined, credential.deviceToken)
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
      const [outgoing, incoming] = await Promise.all([
        client.syncChanges(outgoingCursor.lastAdvanceId, 1, undefined, true),
        remoteClient.syncChanges(incomingCursor.lastAdvanceId, 1, undefined, true),
      ]);
      return outgoing.changes.length || incoming.changes.length ? "pending" : "synced";
    },
    [client, remoteClient],
  );

  const checkSyncState = useCallback(async () => {
    if (deviceAccess !== "ready" || !remoteClient) {
      setSyncState("unconfigured");
      return;
    }
    const epoch = syncEpochRef.current;
    const state = await computeSyncState(remoteClient.peerId());
    if (epoch === syncEpochRef.current) setSyncState(state);
  }, [computeSyncState, deviceAccess, remoteClient]);

  const syncNow = useCallback(() => {
    if (!remoteClient) {
      openSettings();
      return;
    }
    const authEpoch = remoteAuthEpochRef.current;
    const syncEpoch = ++syncEpochRef.current;
    setSyncing(true);
    setSyncProgress(t(locale, "syncPreparing"));
    void (async () => {
      const hydrateNoteContents = async <T extends { entityType: string; changeKind: string; data: Record<string, unknown> | null }>(
        changes: T[],
        source: AttachmentTransferClient,
      ): Promise<T[]> => Promise.all(changes.map(async (change): Promise<T> => {
        if (change.entityType !== "note" || change.changeKind === "deleted" || !change.data || typeof change.data.contentHash !== "string" || typeof change.data.contentData === "string") return change;
        const content = await source.syncNoteContent(String(change.data.id), change.data.contentHash);
        return { ...change, data: { ...change.data, ...content } } as T;
      }));
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
        const transferredHashes = new Set<string>();
        const total = new Set(changes.flatMap((change) => Array.isArray(change.data?.attachmentRefs)
          ? (change.data.attachmentRefs as Array<{ contentHash?: string }>).map((ref) => ref.contentHash).filter((hash): hash is string => Boolean(hash))
          : [])).size;
        let completed = 0;
        for (const change of changes) {
          if (change.entityType !== "note" || change.changeKind === "deleted" || !change.data) continue;
          const noteId = typeof change.data.id === "string" ? change.data.id : undefined;
          const refs = Array.isArray(change.data.attachmentRefs) ? change.data.attachmentRefs as Array<{ id?: string; contentHash?: string; filename?: string }> : [];
          if (!noteId) continue;
          for (const ref of refs) {
            if (!ref.id || !ref.contentHash || !ref.filename || transferredHashes.has(ref.contentHash)) continue;
            const existing = await destination.hasAttachmentByHash(ref.contentHash);
            if (existing.exists && existing.id === ref.id) {
              transferredHashes.add(ref.contentHash);
              completed += 1;
              setSyncProgress(`${t(locale, "syncAttachments")} ${completed}/${total}`);
              continue;
            }
            const file = await source.downloadAttachmentByHash(ref.contentHash);
            await destination.uploadAttachmentByHash(ref.contentHash, noteId, ref.filename, file.blob, destinationOrigin, ref.id);
            transferredHashes.add(ref.contentHash);
            completed += 1;
            setSyncProgress(`${t(locale, "syncAttachments")} ${completed}/${total}`);
          }
        }
      };
      const peer = remoteClient.peerId();
      let incomingCursor = await client.getSyncCursor(`in:${peer}`);
      if (incomingCursor.advancedAt === null) {
        let snapshot = await remoteClient.syncSnapshot(0, 500, true);
        while (snapshot.changes.length) {
          setSyncProgress(`${t(locale, "syncDownloadBaseline")} · ${snapshot.changes.length}`);
          const hydrated = await hydrateNoteContents(snapshot.changes, remoteClient);
          await client.pushSyncChanges(hydrated, "remote");
          await copyAttachments(snapshot.changes, remoteClient, client, "remote");
          if (!snapshot.hasMore) break;
          snapshot = await remoteClient.syncSnapshot(snapshot.cursor, 500, true);
        }
        await client.advanceSyncCursor(`in:${peer}`, snapshot.maxChangeId);
        incomingCursor = await client.getSyncCursor(`in:${peer}`);
      }
      const outgoingCursor = await client.getSyncCursor(`out:${peer}`);
      let outgoing = await client.syncChanges(outgoingCursor.lastAdvanceId, 500, undefined, true);
      while (outgoing.changes.length) {
        setSyncProgress(`${t(locale, "syncUploadMeta")} · ${outgoing.changes.length} · ${formatSyncBytes(outgoing.stats?.serializedBytes ?? 0)}`);
        const hydrated = await hydrateNoteContents(outgoing.changes, client);
        await remoteClient.pushSyncChanges(hydrated);
        await copyAttachments(outgoing.changes, client, remoteClient);
        await client.advanceSyncCursor(`out:${peer}`, outgoing.cursor);
        if (!outgoing.hasMore) break;
        outgoing = await client.syncChanges(outgoing.cursor, 500, undefined, true);
      }
      let incoming = await remoteClient.syncChanges(incomingCursor.lastAdvanceId, 500, undefined, true);
      while (incoming.changes.length) {
        setSyncProgress(`${t(locale, "syncDownloadMeta")} · ${incoming.changes.length} · ${formatSyncBytes(incoming.stats?.serializedBytes ?? 0)}`);
        const hydrated = await hydrateNoteContents(incoming.changes, remoteClient);
        await client.pushSyncChanges(hydrated, "remote");
        await copyAttachments(incoming.changes, remoteClient, client, "remote");
        await client.advanceSyncCursor(`in:${peer}`, incoming.cursor);
        if (!incoming.hasMore) break;
        incoming = await remoteClient.syncChanges(incoming.cursor, 500, undefined, true);
      }
      await refreshTree();
      const finalState = await computeSyncState(peer);
      if (syncEpoch === syncEpochRef.current) setSyncState(finalState);
      showSyncComplete();
      setSyncProgress(undefined);
    })()
      .catch((error) => {
        console.error("Immediate sync failed", error);
        const message = error instanceof Error ? error.message : String(error);
        showToast(`${t(locale, "syncFailed")}${message ? `: ${message}` : ""}`);
        setSyncProgress(`${t(locale, "syncFailedRetry")}: ${message}`);
        if (syncEpoch === syncEpochRef.current) setSyncState("pending");
        if (
          isDesktopApp &&
          isInvalidDeviceToken(error) &&
          authEpoch === remoteAuthEpochRef.current &&
          !remoteReauthInProgressRef.current
        )
          setRemoteReauthRequired(true);
        else openSettings();
      })
      .finally(() => {
        if (syncEpoch === syncEpochRef.current) setSyncing(false);
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

  // --- Sync state refresh ---
  useEffect(() => {
    let cancelled = false;
    const refreshSyncState = () => {
      const authEpoch = remoteAuthEpochRef.current;
      void checkSyncState().catch((error) => {
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
        "桌面端",
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
      const remote = new RemoteProxyClient(target.origin);
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
    syncEpochRef,
    syncAfterBootstrap,
    setSyncAfterBootstrap,
    syncNow,
    checkSyncState,
    showSyncComplete,
  };
}
