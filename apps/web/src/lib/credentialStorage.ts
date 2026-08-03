import { Capacitor } from "@capacitor/core";

const REMOTE_CREDENTIAL_KEY = "ygdria.remote-device-credential";
export const STARTUP_AUTH_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;

export interface RemoteCredential {
  serverUrl: string;
  deviceToken: string;
  /** Epoch milliseconds of the last successful `/devices/me` validation. */
  lastVerifiedAt?: number;
}

/** Whether a locally protected credential was validated recently enough to
 * render the workspace while a fresh validation continues in the background. */
export function hasFreshStartupAuth(
  credential: RemoteCredential | null,
  now = Date.now(),
): boolean {
  return Boolean(
    credential &&
    typeof credential.lastVerifiedAt === "number" &&
    credential.lastVerifiedAt <= now &&
    now - credential.lastVerifiedAt <= STARTUP_AUTH_CACHE_MAX_AGE_MS,
  );
}

/**
 * Native apps must survive a full restart, so the paired-device credential is
 * persisted in the OS secure store (iOS Keychain / Android EncryptedSharedPreferences)
 * via `capacitor-secure-storage-plugin` — never in the plaintext `@capacitor/preferences`.
 * Browsers keep the existing `sessionStorage` behaviour so the web/desktop clients
 * are unchanged. A one-time fallback reads any legacy `@capacitor/preferences`
 * entry, migrates it into the secure store, then removes the plaintext copy.
 */
export async function loadRemoteCredential(): Promise<RemoteCredential | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
      try {
        const { value } = await SecureStoragePlugin.get({ key: REMOTE_CREDENTIAL_KEY });
        return value ? (JSON.parse(value) as RemoteCredential) : null;
      } catch {
        // Key absent from the secure store — attempt a one-time migration from
        // the legacy plaintext @capacitor/preferences entry, if any.
        const { Preferences } = await import("@capacitor/preferences");
        const legacy = await Preferences.get({ key: REMOTE_CREDENTIAL_KEY });
        if (!legacy.value) return null;
        await SecureStoragePlugin.set({ key: REMOTE_CREDENTIAL_KEY, value: legacy.value });
        await Preferences.remove({ key: REMOTE_CREDENTIAL_KEY });
        return JSON.parse(legacy.value) as RemoteCredential;
      }
    } catch {
      return null;
    }
  }
  const raw = window.sessionStorage.getItem(REMOTE_CREDENTIAL_KEY);
  return raw ? (JSON.parse(raw) as RemoteCredential) : null;
}

export async function saveRemoteCredential(credential: RemoteCredential): Promise<void> {
  const payload = JSON.stringify(credential);
  if (Capacitor.isNativePlatform()) {
    try {
      const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
      await SecureStoragePlugin.set({ key: REMOTE_CREDENTIAL_KEY, value: payload });
    } catch {
      /* ignore */
    }
    return;
  }
  window.sessionStorage.setItem(REMOTE_CREDENTIAL_KEY, payload);
}

export async function clearRemoteCredential(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
      await SecureStoragePlugin.remove({ key: REMOTE_CREDENTIAL_KEY });
    } catch {
      /* ignore */
    }
    return;
  }
  window.sessionStorage.removeItem(REMOTE_CREDENTIAL_KEY);
}
