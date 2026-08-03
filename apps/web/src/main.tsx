import { useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { YgdriaClient } from "@ygdria/api-client";
import { App } from "./app/App";
import { initCapacitor } from "./lib/capacitor";
import { isPhoneLayout } from "./lib/mobileLayout";
import { hasFreshStartupAuth, loadRemoteCredential } from "./lib/credentialStorage";
import { readSettings, writeSettings } from "./features/settings/settingsStore";
import { initShareReceiver } from "./lib/shareReceiver";
import { t, detectLocale, type Locale } from "./lib/i18n";
import "./style.css";

export const MOBILE_API_ENDPOINT_KEY = "ygdria.api";

// Apply the native-shell body class as early as possible — before React renders
// — so the mobile-only CSS in `styles/responsive/capacitor.css` is active on
// the very first paint. Without this, the first interaction (e.g. opening the
// note-tree drawer) shows the layout in its 4-column desktop fallback for a
// frame or two while `initCapacitor()` resolves asynchronously. `initCapacitor`
// still does the same `classList.add` later, but doing it here synchronously
// closes the race where Android WebViews that report a desktop-sized viewport
// render the wrong shell until the class lands.
if (Capacitor.isNativePlatform() && typeof document !== "undefined") {
  document.body.classList.add("capacitor-native");
}

// Register the OS share-target listener as early as possible so a share that
// cold-launches the app is captured before React mounts. No-op in the browser
// or when the CapacitorShareTarget plugin is unavailable.
void initShareReceiver();

// The unified phone layout is driven by the `.phone` class on <html> (see
// styles/responsive/breakpoints.css). Add it synchronously BEFORE first paint
// for (a) native handsets and (b) a browser/PWA that is already narrow on load
// (DevTools device-emulation, installed PWA). A native *tablet* (iPad, etc.)
// keeps the larger inline layout, so we route the decision through
// `isPhoneLayout()` which discriminates on short-side width + pointer type.
// App.tsx keeps it in sync on resize. Doing it here avoids a one-frame desktop
// flash on narrow loads.
if (typeof document !== "undefined") {
  if (isPhoneLayout()) document.documentElement.classList.add("phone");
}

export function normalizeMobileApiEndpoint(value: string, locale: Locale) {
  const endpoint = new URL(value.trim());
  if (endpoint.protocol !== "https:") throw new Error(t(locale, "mobileOnlyHttps"));
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

function MobileEndpointGate() {
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const locale = detectLocale();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    void (async () => {
      const endpoint = normalizeMobileApiEndpoint(serverUrl, locale);
      // Persist to settings (the unified target server address) and keep the
      // legacy preference in sync for backward compatibility.
      writeSettings({ ...readSettings(), syncServerUrl: endpoint });
      await Preferences.set({ key: MOBILE_API_ENDPOINT_KEY, value: endpoint });
      window.location.reload();
    })()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t(locale, "mobileServerSaveError")),
      )
      .finally(() => setSaving(false));
  };

  return (
    <main className="device-access-shell">
      <section className="device-access-card" aria-labelledby="mobile-server-title">
        <form onSubmit={submit}>
          <div>
            <h1 id="mobile-server-title">{t(locale, "deviceAccessLogin")}</h1>
            <p>{t(locale, "mobileServerDesc")}</p>
          </div>
          <label>
            <span>{t(locale, "mobileServerUrlLabel")}</span>
            <input
              autoFocus
              type="url"
              inputMode="url"
              value={serverUrl}
              placeholder={t(locale, "serverUrlPlaceholder")}
              onChange={(event) => {
                setServerUrl(event.target.value);
                setError(undefined);
              }}
            />
          </label>
          {error && (
            <p className="device-access-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={!serverUrl.trim() || saving}>
            {saving ? t(locale, "processing") : t(locale, "mobileContinueLogin")}
          </button>
        </form>
      </section>
    </main>
  );
}

async function bootstrap() {
  // Electron provides the per-launch loopback credential through the isolated
  // preload bridge. Browser/Vite deployments retain the same-origin client.
  const connection = await window.ygdria?.connection().catch(() => undefined);
  const isNativeMobile = Capacitor.isNativePlatform();
  const storedMobileEndpoint = isNativeMobile
    ? (await Preferences.get({ key: MOBILE_API_ENDPOINT_KEY })).value
    : undefined;
  // On mobile the single source of truth for the server address is the
  // "目标服务器地址" (syncServerUrl) from settings. The legacy ygdria.api
  // preference is only a fallback for installs that predate the merge.
  const settings = isNativeMobile ? readSettings() : undefined;
  const effectiveMobileEndpoint =
    settings?.syncServerUrl?.trim() || storedMobileEndpoint || import.meta.env.VITE_API_URL || "";
  // One-time merge: fold the legacy mobile endpoint into settings so there is
  // a single server address.
  if (isNativeMobile && storedMobileEndpoint) {
    const current = readSettings();
    if (!current.syncServerUrl?.trim())
      writeSettings({ ...current, syncServerUrl: storedMobileEndpoint });
  }
  // Restore the device token from the OS secure store (iOS Keychain / Android
  // EncryptedSharedPreferences) before constructing the API client. The token
  // is what the server returns after SRP login, so persisting it is what lets
  // cold launches skip the master-password prompt. The previous bootstrap only
  // read `sessionStorage`, which is empty on every fresh WebView, forcing a
  // full SRP round-trip on every app start. The credential is only adopted if
  // its server URL still matches the effective endpoint — otherwise a
  // user who switched backends would get a misleading 401.
  let restoredDeviceToken: string | undefined;
  let hasCachedStartupAuth = false;
  if (isNativeMobile) {
    const credential = await loadRemoteCredential();
    if (
      credential?.deviceToken &&
      (!effectiveMobileEndpoint || credential.serverUrl === effectiveMobileEndpoint)
    ) {
      restoredDeviceToken = credential.deviceToken;
      hasCachedStartupAuth = hasFreshStartupAuth(credential);
    }
  }
  if (isNativeMobile && !effectiveMobileEndpoint) {
    createRoot(document.getElementById("root")!).render(<MobileEndpointGate />);
    void initCapacitor();
    return;
  }
  const client = new YgdriaClient(
    isNativeMobile
      ? effectiveMobileEndpoint
      : (connection?.baseUrl ?? import.meta.env.VITE_API_URL ?? ""),
    connection?.token,
    restoredDeviceToken,
  );
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={new QueryClient()}>
      <App client={client} hasCachedStartupAuth={hasCachedStartupAuth} />
    </QueryClientProvider>,
  );
  // Apply native-shell tweaks (status bar, keyboard, back button). No-op in a
  // browser or Electron where Capacitor reports a non-native platform.
  void initCapacitor();
}

void bootstrap();
