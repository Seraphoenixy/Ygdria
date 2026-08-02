import { useCallback, useEffect, useState } from "react";
import type { YgdriaClient } from "@ygdria/api-client";
import {
  DEFAULT_PROTECTED_SESSION_TIMEOUT_MS,
  MIN_PROTECTED_SESSION_TIMEOUT_MS,
  ProtectedClientSession,
  assertAuthConfigSupported,
  deriveAccessSecret,
  generateSaltB64,
  srpBeginLogin,
  srpDeriveClientSession,
  srpRegister,
  srpVerifyServer,
  type ProtectedPayload,
} from "../lib/client-crypto";
import type { Locale } from "../lib/i18n";
import { t } from "../lib/i18n";
import type { TreePlacement } from "../types/workspace";

const SESSION_DEVICE_TOKEN_KEY = "ygdria.device-token";

export type PasswordDialogMode = "setup" | "unlock" | "change" | null;

type UseProtectedSessionOptions = {
  client: YgdriaClient;
  requiresDeviceAuth: boolean;
  deviceAccess: "checking" | "ready" | "initialize" | "login";
  refreshTree: () => void;
  setDeviceAccess: (access: "checking" | "ready" | "initialize" | "login") => void;
  treeData: TreePlacement[] | undefined;
  locale: Locale;
};

export function useProtectedSession({
  client,
  requiresDeviceAuth,
  deviceAccess,
  refreshTree,
  setDeviceAccess,
  treeData,
  locale,
}: UseProtectedSessionOptions) {
  const [session] = useState(() => new ProtectedClientSession());
  const [protectedSession, setProtectedSession] = useState<{
    configured: boolean;
    unlocked: boolean;
    timeoutMs: number;
  }>({ configured: false, unlocked: false, timeoutMs: DEFAULT_PROTECTED_SESSION_TIMEOUT_MS });
  const [decryptedTitles, setDecryptedTitles] = useState<Map<string, string>>(new Map());
  const [passwordDialog, setPasswordDialog] = useState<PasswordDialogMode>(null);

  // Fetch server session config on mount to initialise client-side session state
  useEffect(() => {
    if (deviceAccess !== "ready") return;
    void client
      .protectedSession()
      .then((state) => {
        setProtectedSession((prev) => ({
          ...prev,
          configured: state.configured,
          timeoutMs: state.timeoutMs,
        }));
      })
      .catch(() => undefined);
  }, [client, deviceAccess]);

  // Auto-lock callback: when the client session locks, update UI state
  useEffect(() => {
    session.setOnLock(() => {
      setProtectedSession((prev) => {
        if (prev.unlocked) return { ...prev, unlocked: false };
        return prev;
      });
      setDecryptedTitles(new Map());
      refreshTree();
    });
    return () => session.setOnLock(null);
  }, [session, refreshTree]);

  // Decrypt protected note titles for the tree when the session is unlocked.
  useEffect(() => {
    if (!protectedSession.unlocked) {
      setDecryptedTitles(new Map());
      return;
    }
    const placements = treeData ?? [];
    const protectedPlacements = placements.filter((p) => p.isProtected && p.contentJson);
    if (protectedPlacements.length === 0) {
      setDecryptedTitles(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = new Map<string, string>();
      for (const placement of protectedPlacements) {
        try {
          const payload = await session.decrypt<ProtectedPayload>(placement.contentJson!);
          if (payload.title) next.set(placement.noteId, payload.title);
        } catch {
          // Skip unreadable payloads — the placeholder will be shown instead.
        }
      }
      if (!cancelled) setDecryptedTitles(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [protectedSession.unlocked, treeData, session]);

  const handleProtectedSessionToggle = useCallback(() => {
    if (protectedSession.unlocked) {
      session.lock();
      return;
    }
    setPasswordDialog(protectedSession.configured ? "unlock" : "setup");
  }, [protectedSession.configured, protectedSession.unlocked, session]);

  const handleProtectedSessionTimeoutChange = useCallback(
    (minutes: number) => {
      const timeoutMs =
        Math.max(
          Math.ceil(MIN_PROTECTED_SESSION_TIMEOUT_MS / 60_000),
          Math.floor(minutes),
        ) * 60_000;
      session.setTimeoutMs(timeoutMs);
      void client
        .setProtectedSessionTimeout(timeoutMs)
        .then((result) =>
          setProtectedSession((current) => ({ ...current, timeoutMs: result.timeoutMs })),
        );
    },
    [client, session],
  );

  const handlePasswordSubmit = useCallback(
    async (password: string, currentPassword?: string) => {
      try {
        if (passwordDialog === "change") {
          const config = await client.protectedSession();
          if (!currentPassword || !config.salt || !config.verifier)
            throw new Error("Session not configured on server");
          const currentSession = new ProtectedClientSession();
          await currentSession.unlock(currentPassword, config.salt, config.verifier);
          const protectedNotes = new Map<
            string,
            { payload: ProtectedPayload; expectedVersion: number }
          >();
          for (const placement of treeData ?? []) {
            if (!placement.isProtected || protectedNotes.has(placement.noteId)) continue;
            const protectedNote = await client.getNote(placement.noteId);
            protectedNotes.set(placement.noteId, {
              payload: await currentSession.decrypt<ProtectedPayload>(
                protectedNote.contentCiphertext,
              ),
              expectedVersion: protectedNote.version,
            });
          }
          const nextSession = new ProtectedClientSession();
          await nextSession.setup(password);
          const notes = await Promise.all(
            [...protectedNotes].map(async ([id, note]) => ({
              id,
              contentCiphertext: await nextSession.encrypt(note.payload),
              expectedVersion: note.expectedVersion,
            })),
          );
          const newAccessSalt = generateSaltB64();
          const newAccessSecret = await deriveAccessSecret(password, newAccessSalt);
          const newRegistration = srpRegister(newAccessSecret);
          let reauthToken: string | undefined;
          if (requiresDeviceAuth) {
            // Step-up: re-verify the *current* master password via SRP to obtain
            // a short-lived reauth token, required by the server in device-auth
            // mode before migrating the SRP verifier (account-takeover defense).
            const config = await client.authConfig();
            assertAuthConfigSupported(config);
            if (!config.accessSalt || !config.srpSalt)
              throw new Error("服务尚未初始化主密码，无法验证当前主密码。");
            const accessSecret = await deriveAccessSecret(
              currentPassword!,
              config.accessSalt,
            );
            const clientEphemeral = srpBeginLogin();
            const challenge = await client.srpLoginChallenge(clientEphemeral.public);
            const clientSession = srpDeriveClientSession(
              clientEphemeral,
              challenge.serverPublicEphemeral,
              challenge.srpSalt,
              accessSecret,
            );
            const credential = await client.srpLoginVerify(
              challenge.challengeId,
              clientEphemeral.public,
              clientSession.proof,
              "桌面端",
            );
            srpVerifyServer(clientEphemeral, clientSession, credential.serverSessionProof);
            reauthToken = credential.reauthToken;
          }
          await client.changeProtectedPassword(
            nextSession.salt!,
            nextSession.verifier!,
            protectedSession.timeoutMs,
            notes,
            {
              accessSalt: newAccessSalt,
              srpSalt: newRegistration.srpSalt,
              verifier: newRegistration.verifier,
            },
            reauthToken,
          );
          session.lock();
          client.setDeviceToken(undefined);
          window.sessionStorage.removeItem(SESSION_DEVICE_TOKEN_KEY);
          setProtectedSession((current) => ({
            ...current,
            configured: true,
            unlocked: false,
          }));
          setPasswordDialog(null);
          setDeviceAccess("login");
          refreshTree();
          return;
        } else if (passwordDialog === "setup") {
          await session.setup(password);
          if (requiresDeviceAuth) {
            const config = await client.authConfig();
            assertAuthConfigSupported(config);
            if (!config.accessSalt) throw new Error("服务尚未初始化主密码，请刷新后重试。");
            const accessSecret = await deriveAccessSecret(password, config.accessSalt);
            const registration = srpRegister(accessSecret);
            await client.setupProtectedSession(
              session.salt!,
              session.verifier!,
              protectedSession.timeoutMs,
              {
                accessSalt: config.accessSalt,
                srpSalt: registration.srpSalt,
                verifier: registration.verifier,
              },
            );
            session.lock();
            client.setDeviceToken(undefined);
            window.sessionStorage.removeItem(SESSION_DEVICE_TOKEN_KEY);
            setProtectedSession((current) => ({
              ...current,
              configured: true,
              unlocked: false,
            }));
            setPasswordDialog(null);
            setDeviceAccess("login");
            refreshTree();
            return;
          } else {
            await client.setupProtectedSession(
              session.salt!,
              session.verifier!,
              protectedSession.timeoutMs,
            );
          }
        } else {
          const config = await client.protectedSession();
          if (!config.salt || !config.verifier)
            throw new Error("Session not configured on server");
          await session.unlock(password, config.salt, config.verifier);
        }
        setProtectedSession((current) => ({
          ...current,
          configured: true,
          unlocked: true,
        }));
        refreshTree();
        setPasswordDialog(null);
      } catch (error) {
        console.error("Unable to handle protected session", error);
        throw error;
      }
    },
    [
      client,
      passwordDialog,
      protectedSession.timeoutMs,
      refreshTree,
      requiresDeviceAuth,
      session,
      setDeviceAccess,
      treeData,
    ],
  );

  return {
    session,
    protectedSession,
    setProtectedSession,
    decryptedTitles,
    passwordDialog,
    setPasswordDialog,
    handleProtectedSessionToggle,
    handleProtectedSessionTimeoutChange,
    handlePasswordSubmit,
  };
}