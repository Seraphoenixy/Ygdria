import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { buildApp } from "../../server/src/app";
import { deferQuitOnce, startupFailureDialog } from "./startup";

let window: BrowserWindow | undefined;
let apiUrl = "";
let localApi: ReturnType<typeof buildApp> | undefined;
let localApiToken = "";
const quitState = { quitting: false };
const isQuitting = () => quitState.quitting;
let closeLocalApiPromise: Promise<void> | undefined;
let focusRequestedBeforeWindowExists = false;
const REMOTE_REQUEST_TIMEOUT_MS = 120_000;
const legacyUserDataPath = app.getPath("userData");
const appDataPath = app.getPath("appData");

// This entry is bundled as CommonJS for Electron.  Do not use
// `import.meta.dirname` here: Vite's CJS output does not define it.
const desktopAppPath = app.getAppPath();
const desktopWindowIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.resolve(desktopAppPath, "../../assets/icons/ygdria-forest.ico");

async function closeLocalApi() {
  if (closeLocalApiPromise) return closeLocalApiPromise;
  const api = localApi;
  localApi = undefined;
  apiUrl = "";
  const closing = api ? api.close() : Promise.resolve();
  closeLocalApiPromise = closing;
  try {
    await closing;
  } finally {
    if (closeLocalApiPromise === closing) closeLocalApiPromise = undefined;
  }
}

function quitAfterClosingLocalApi(exitCode?: number) {
  deferQuitOnce(
    quitState,
    () =>
      closeLocalApi().catch((error) => {
        console.error("Failed to close Ygdria local API cleanly", error);
      }),
    () => {
      if (exitCode === undefined) app.quit();
      else app.exit(exitCode);
    },
  );
}
const minimumZoomLevel = -5;
const maximumZoomLevel = 5;

function clampZoomLevel(level: number) {
  return Math.max(minimumZoomLevel, Math.min(maximumZoomLevel, level));
}

function zoomPreferencesPath() {
  return path.join(app.getPath("userData"), "window-preferences.json");
}

function readZoomLevel() {
  try {
    const { zoomLevel } = JSON.parse(readFileSync(zoomPreferencesPath(), "utf8")) as { zoomLevel?: unknown };
    return typeof zoomLevel === "number" && Number.isFinite(zoomLevel) ? clampZoomLevel(zoomLevel) : 0;
  } catch {
    return 0;
  }
}

function writeZoomLevel(zoomLevel: number) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(zoomPreferencesPath(), JSON.stringify({ zoomLevel: clampZoomLevel(zoomLevel) }));
  } catch {
    // A read-only profile should not prevent the desktop app from working.
  }
}

function openInSystemBrowser(url: string) {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      void shell.openExternal(url);
    }
  } catch {
    // Ignore malformed links rather than letting a renderer navigate away.
  }
}

function isTrustedAppUrl(url: string) {
  try {
    const candidate = new URL(url);
    const appOrigins = [process.env.VITE_DEV_SERVER_URL, apiUrl]
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(value).origin);
    return appOrigins.includes(candidate.origin);
  } catch {
    return false;
  }
}

/** Reject IPC calls from any page other than the current local/Vite app. */
function assertTrustedIpcSender(event: IpcMainInvokeEvent) {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedAppUrl(senderUrl))
    throw new Error("Untrusted renderer attempted to access the remote proxy");
}

app.setName("Ygdria");
app.setPath("userData", path.join(appDataPath, "Ygdria"));
// Keep Electron's disposable session cache alongside the app data. This avoids
// creating a second top-level "Ygdria Cache" folder in the user's profile.
app.setPath("sessionData", path.join(appDataPath, "Ygdria", "session-data"));
// Configure the app-specific data path before claiming the process lock, then
// acquire it before any database or local-server work begins.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
}

function databasePath() {
  const dataPath = path.join(app.getPath("userData"), "data");
  mkdirSync(dataPath, { recursive: true });
  const database = path.join(dataPath, "ygdria.db");
  if (!existsSync(database)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = path.join(legacyUserDataPath, `ygdria.db${suffix}`);
      if (existsSync(source)) copyFileSync(source, path.join(dataPath, `ygdria.db${suffix}`));
    }
  }
  return database;
}

function etapiSessionStorePath() {
  return path.join(app.getPath("userData"), "etapi-sessions.json");
}

async function startLocalApiWithRetry() {
  while (!isQuitting()) {
    try {
      const databaseUrl = databasePath();
      const webDist = app.isPackaged
        ? path.join(process.resourcesPath, "web")
        : path.resolve(desktopAppPath, "../web/dist");
      localApiToken = randomBytes(32).toString("base64url");
      localApi = buildApp({
        databaseUrl,
        webDist,
        origin: "http://localhost:5173",
        localToken: localApiToken,
        enableEtapi: true,
        etapiSessionStorePath: etapiSessionStorePath(),
      });
      apiUrl = await localApi.listen({
        // Keep the loopback endpoint discoverable for local integrations. The
        // per-launch local token, not port obscurity, protects this API.
        port: 4318,
        host: "127.0.0.1",
      });
      return true;
    } catch (error) {
      console.error("Failed to start Ygdria local API", error);
      await closeLocalApi().catch((closeError) => console.error("Failed to close Ygdria local API", closeError));
      const failure = startupFailureDialog(error);
      const response = await dialog.showMessageBox({
        type: "error",
        title: failure.title,
        message: failure.message,
        detail: failure.detail,
        buttons: ["Retry", "Exit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response.response !== 0) return false;
    }
  }
  return false;
}

function focusMainWindow() {
  const mainWindow = window ?? BrowserWindow.getAllWindows().at(0);
  if (!mainWindow) {
    focusRequestedBeforeWindowExists = true;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Remote server proxy state. The main process holds the server URL and device
 * token in memory and persists them via safeStorage. The renderer NEVER sees
 * the plaintext deviceToken — it can only request high-level remote operations
 * through the `ygdria:remote:*` IPC channels.
 */
let remoteServerUrl = "";
let remoteToken = "";
let pendingRemoteServerUrl = "";

/** Encrypted store for the remote server's deviceToken (form B access). */
function deviceCredentialPath() {
  return path.join(app.getPath("userData"), "device-credential.dat");
}

function readRemoteCredential(): { serverUrl: string; deviceToken: string } | null {
  const file = deviceCredentialPath();
  if (!existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const decrypted = safeStorage.decryptString(readFileSync(file));
    const parsed = JSON.parse(decrypted) as { serverUrl?: string; deviceToken?: string };
    if (!parsed.serverUrl) return null;
    // deviceToken may be empty when the server URL was configured but the
    // user has not yet authenticated.
    return { serverUrl: parsed.serverUrl, deviceToken: parsed.deviceToken ?? "" };
  } catch {
    return null;
  }
}

function writeRemoteCredential(credential: { serverUrl: string; deviceToken: string }) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("System secure storage is unavailable on this device.");
  mkdirSync(path.dirname(deviceCredentialPath()), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(credential));
  writeFileSync(deviceCredentialPath(), encrypted);
}

function clearRemoteCredential() {
  const file = deviceCredentialPath();
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best effort */ }
  }
}

/**
 * Path allowlist for the remote proxy. The renderer may only request these
 * paths — the main process rejects anything else, preventing the IPC from
 * being abused as a general-purpose SSRF proxy.
 */
const REMOTE_PATH_ALLOWLIST: ReadonlyArray<{ method: string; pathPrefix: string }> = [
  // Public auth endpoints (no token required, but token is injected if present)
  { method: "GET",  pathPrefix: "/api/v1/health" },
  { method: "GET",  pathPrefix: "/api/v1/auth/config" },
  { method: "POST", pathPrefix: "/api/v1/devices/initialize" },
  { method: "POST", pathPrefix: "/api/v1/auth/login/challenge" },
  { method: "POST", pathPrefix: "/api/v1/auth/login/verify" },
  // Authenticated sync endpoints
  { method: "GET",  pathPrefix: "/api/v1/sync/changes" },
  { method: "GET",  pathPrefix: "/api/v1/sync/snapshot" },
  { method: "POST", pathPrefix: "/api/v1/sync/push" },
  { method: "POST", pathPrefix: "/api/v1/sync/advance" },
  { method: "POST", pathPrefix: "/api/v1/sync/notes/content/batch" },
  { method: "GET",  pathPrefix: "/api/v1/sync/cursor" },
  { method: "GET",  pathPrefix: "/api/v1/sync/notes/" },
  // Sync conflict resolution fetches the authoritative note, and the client
  // reads the remote protected-session configuration while establishing sync.
  { method: "GET",  pathPrefix: "/api/v1/notes/" },
  { method: "GET",  pathPrefix: "/api/v1/protected-session" },
  { method: "POST", pathPrefix: "/api/v1/protected-session/setup" },
  // Authenticated attachment transfer (binary)
  { method: "GET",  pathPrefix: "/api/v1/attachments/by-hash/" },
  { method: "POST", pathPrefix: "/api/v1/attachments/by-hash/" },
];

/** Paths whose JSON response contains a `deviceToken` that must be intercepted
 *  and stored by the main process, never returned to the renderer. */
const REMOTE_TOKEN_INTERCEPT_PATHS = new Set([
  "/api/v1/devices/initialize",
  "/api/v1/auth/login/verify",
]);

function isAllowedRemotePath(method: string, requestPath: string): boolean {
  const cleanPath = requestPath.split("?")[0];
  return REMOTE_PATH_ALLOWLIST.some(
    (entry) => entry.method === method && cleanPath.startsWith(entry.pathPrefix),
  );
}

async function createWindow(initialTab?: unknown) {
  window = new BrowserWindow({
    icon: desktopWindowIconPath,
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: "#fbfbfc",
    webPreferences: {
      preload: path.join(desktopAppPath, "out", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // A note is rendered in the app's own origin.  Its hyperlinks must never
  // replace that renderer or create an untrusted Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    // `loadURL` can also emit this event.  Keep navigation within the active
    // Vite/local-app origin inside Electron; only hand off genuine external links.
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    openInSystemBrowser(url);
  });
  const targetUrl = new URL(process.env.VITE_DEV_SERVER_URL ?? apiUrl);
  if (initialTab) targetUrl.searchParams.set("ygdria-tab", JSON.stringify(initialTab));
  window.webContents.setZoomLevel(readZoomLevel());
  await window.loadURL(targetUrl.toString());
}

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return;
    Menu.setApplicationMenu(null);
    if (!(await startLocalApiWithRetry())) {
      quitAfterClosingLocalApi(1);
      return;
    }
    ipcMain.handle("ygdria:connection", () => ({
      baseUrl: apiUrl,
      token: localApiToken,
    }));
    // Load any previously persisted remote server credential.
    const stored = readRemoteCredential();
    if (stored) {
      remoteServerUrl = stored.serverUrl;
      remoteToken = stored.deviceToken;
    }
    // --- Remote proxy IPC --------------------------------------------------
    // The renderer never sees the deviceToken. It asks the main process to
    // configure, disconnect, or make a specific allowed request. The main
    // process injects the Authorization header, enforces the HTTPS origin,
    // disables redirects, and intercepts tokens from init/verify responses.
    ipcMain.handle("ygdria:remote:status", (event) => {
      assertTrustedIpcSender(event);
      return {
      configured: Boolean(remoteServerUrl),
      serverUrl: remoteServerUrl || null,
      authenticated: Boolean(remoteToken),
      };
    });
    ipcMain.handle("ygdria:remote:configure", (event, serverUrl: string) => {
      assertTrustedIpcSender(event);
      let parsed: URL;
      try { parsed = new URL(serverUrl); } catch { throw new Error("Invalid server URL"); }
      if (parsed.protocol !== "https:") throw new Error("Remote server must use HTTPS");
      if (parsed.username || parsed.password) throw new Error("Remote URL must not contain credentials");
      // Normalise to origin (strip path/query/fragment). Subpath deployments
      // are not supported for the remote server — its API is always at root.
      // Do not overwrite a working saved credential until this candidate has
      // completed initialization or PAKE login and produced a new token.
      pendingRemoteServerUrl = parsed.origin;
      return true;
    });
    ipcMain.handle("ygdria:remote:disconnect", (event) => {
      assertTrustedIpcSender(event);
      remoteServerUrl = "";
      remoteToken = "";
      pendingRemoteServerUrl = "";
      clearRemoteCredential();
      return true;
    });
    // One-off health check — does NOT persist the URL or clear existing state.
    // Used by the settings "test connection" button before the user commits.
    ipcMain.handle("ygdria:remote:test", async (event, serverUrl: string, timeoutSeconds: number) => {
      assertTrustedIpcSender(event);
      let parsed: URL;
      try { parsed = new URL(serverUrl); } catch { throw new Error("Invalid server URL"); }
      if (parsed.protocol !== "https:") throw new Error("Remote server must use HTTPS");
      if (parsed.username || parsed.password) throw new Error("Remote URL must not contain credentials");
      const fullUrl = parsed.origin + "/api/v1/health";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
      try {
        const response = await fetch(fullUrl, { signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
        await response.json();
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("Connection timed out");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
    ipcMain.handle("ygdria:remote:request", async (event, init: {
      method: string;
      path: string;
      body?: string | ArrayBuffer;
      headers?: Record<string, string>;
    }) => {
      assertTrustedIpcSender(event);
      const targetServerUrl = pendingRemoteServerUrl || remoteServerUrl;
      if (!targetServerUrl) throw new Error("Remote server is not configured");
      if (!init.path.startsWith("/")) throw new Error("Request path must start with /");
      if (!isAllowedRemotePath(init.method, init.path)) throw new Error("Request path is not allowed by the remote proxy");
      // String concatenation (not URL resolution) preserves subpath bases and
      // keeps the allowlist check meaningful.
      const fullUrl = targetServerUrl + init.path;
      let parsedFull: URL;
      try { parsedFull = new URL(fullUrl); } catch { throw new Error("Invalid request URL"); }
      // SSRF guard: the resolved URL must stay on the configured origin.
      if (parsedFull.origin !== new URL(targetServerUrl).origin) {
        throw new Error("Request resolves outside the configured server origin");
      }
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (remoteToken && targetServerUrl === remoteServerUrl) headers["Authorization"] = `Bearer ${remoteToken}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REMOTE_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(fullUrl, {
          method: init.method,
          headers,
          body: init.body as BodyInit | undefined,
          redirect: "error", // no redirects — prevents origin hopping
          signal: controller.signal,
        });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const code =
          cause && typeof cause === "object" && "code" in cause
            ? String((cause as { code?: unknown }).code ?? "")
            : "";
        const message = controller.signal.aborted
          ? `Remote request timed out after ${REMOTE_REQUEST_TIMEOUT_MS / 1000}s`
          : `Remote request failed${code ? ` (${code})` : ""}`;
        console.warn(message, { method: init.method, path: parsedFull.pathname });
        throw new Error(message);
      } finally {
        clearTimeout(timeout);
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      const cleanPath = init.path.split("?")[0];
      const contentType = responseHeaders["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        const text = await response.text();
        let parsed: unknown = null;
        if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        // Intercept deviceToken from successful init/verify responses.
        if (response.ok && REMOTE_TOKEN_INTERCEPT_PATHS.has(cleanPath) &&
            typeof parsed === "object" && parsed !== null && "deviceToken" in parsed) {
          const obj = parsed as { deviceToken?: string; [k: string]: unknown };
          if (obj.deviceToken) {
            remoteServerUrl = targetServerUrl;
            pendingRemoteServerUrl = "";
            remoteToken = obj.deviceToken;
            try { writeRemoteCredential({ serverUrl: remoteServerUrl, deviceToken: remoteToken }); } catch { /* in-memory only */ }
          }
          const { deviceToken: _stripped, ...sanitized } = obj;
          return { status: response.status, body: sanitized, headers: responseHeaders, isBinary: false };
        }
        return { status: response.status, body: parsed, headers: responseHeaders, isBinary: false };
      }
      // Binary response (attachment download)
      const buffer = await response.arrayBuffer();
      return { status: response.status, body: buffer, headers: responseHeaders, isBinary: true };
    });
    ipcMain.handle(
      "ygdria:window-control",
      (event, action: "minimize" | "toggle-maximize" | "close") => {
        const target = BrowserWindow.fromWebContents(event.sender);
        if (!target) return;
        if (action === "minimize") target.minimize();
        if (action === "toggle-maximize") {
          if (target.isMaximized()) target.unmaximize();
          else target.maximize();
        }
        if (action === "close") target.close();
        return target.isMaximized();
      },
    );
    ipcMain.handle("ygdria:open-tab-window", async (_event, tab: unknown) => {
      await createWindow(tab);
    });
    ipcMain.handle("ygdria:zoom", (event, direction: number) => {
      const target = BrowserWindow.fromWebContents(event.sender);
      if (!target || !Number.isFinite(direction) || direction === 0) return;
      const nextLevel = clampZoomLevel(target.webContents.getZoomLevel() + Math.sign(direction));
      target.webContents.setZoomLevel(nextLevel);
      writeZoomLevel(nextLevel);
      return target.webContents.getZoomFactor();
    });
    ipcMain.handle("ygdria:open-devtools", (event) => {
      assertTrustedIpcSender(event);
      event.sender.openDevTools({ mode: "detach" });
    });
    await createWindow();
    if (focusRequestedBeforeWindowExists) {
      focusRequestedBeforeWindowExists = false;
      focusMainWindow();
    }
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow();
    });
  })
  .catch((error) => {
    console.error("Failed to start Ygdria desktop", error);
    quitAfterClosingLocalApi(1);
  });
app.on("before-quit", (event) => {
  if (isQuitting()) return;
  // Keep Electron alive until Fastify closes its sole SQLite connection. The
  // close hook checkpoints and truncates the WAL before releasing the database.
  event.preventDefault();
  // quitAfterClosingLocalApi raises the quitting flag itself and re-issues
  // app.quit() once the API has closed; that second before-quit then passes
  // through the guard above.
  quitAfterClosingLocalApi();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
