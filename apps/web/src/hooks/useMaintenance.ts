import { useCallback, useEffect, useState } from "react";
import type { YgdriaClient } from "@ygdria/api-client";
import type { Locale } from "../lib/i18n";
import { t } from "../lib/i18n";
import { readSettings } from "../features/settings/settingsStore";

const SETTINGS_DURATION_MS = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;

function formatBytes(bytes: number, locale: Locale) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export interface UseMaintenanceOptions {
  client: YgdriaClient;
  locale: Locale;
  deviceAccess: string;
  isDesktopApp: boolean;
}

export function useMaintenance({
  client,
  locale,
  deviceAccess,
  isDesktopApp,
}: UseMaintenanceOptions) {
  const [clearingExcessRevisions, setClearingExcessRevisions] = useState(false);
  const [revisionCleanupMessage, setRevisionCleanupMessage] = useState<string>();
  const [maintainingDatabase, setMaintainingDatabase] = useState(false);
  const [databaseMaintenanceMessage, setDatabaseMaintenanceMessage] = useState<string>();
  const [databaseMaintenanceMessageTarget, setDatabaseMaintenanceMessageTarget] = useState<
    "compact" | "fts"
  >("compact");
  const [testingSyncConnection, setTestingSyncConnection] = useState(false);
  const [syncConnectionMessage, setSyncConnectionMessage] = useState<string>();

  // Auto cleanup: purge expired trash and clear unused attachments
  useEffect(() => {
    if (deviceAccess !== "ready") return;
    const cleanExpired = () => {
      const settings = readSettings();
      const trashAge =
        Math.max(0, settings.trashRetentionDays) *
        SETTINGS_DURATION_MS[settings.trashRetentionUnit];
      const attachmentAge =
        Math.max(0, settings.attachmentRetentionDays) *
        SETTINGS_DURATION_MS[settings.attachmentRetentionUnit];
      const current = Date.now();
      if (trashAge > 0) void client.purgeTrash(current - trashAge).catch(() => {});
      if (attachmentAge > 0)
        void client.clearUnusedAttachments(current - attachmentAge).catch(() => {});
    };
    cleanExpired();
    const timer = window.setInterval(cleanExpired, 60_000);
    return () => window.clearInterval(timer);
  }, [client, deviceAccess]);

  const clearExcessRevisions = useCallback(
    (limit: number) => {
      setClearingExcessRevisions(true);
      setRevisionCleanupMessage(undefined);
      void client
        .clearExcessRevisions(limit)
        .then(({ count }) =>
          setRevisionCleanupMessage(
            t(locale, "revisionsCleared", { count: String(count) }),
          ),
        )
        .catch(() => setRevisionCleanupMessage(t(locale, "revisionCleanupFailed")))
        .finally(() => setClearingExcessRevisions(false));
    },
    [client, locale],
  );

  const maintainDatabase = useCallback(
    (rebuildFts = false) => {
      setMaintainingDatabase(true);
      setDatabaseMaintenanceMessage(undefined);
      setDatabaseMaintenanceMessageTarget(rebuildFts ? "fts" : "compact");
      void (async () => {
        try {
          const { id } = rebuildFts
            ? await client.rebuildSearchIndex()
            : await client.maintainDatabase();
          // Poll until the task completes.
          const poll = async (): Promise<void> => {
            const status = await client.maintenanceStatus();
            if (!status.task) return;
            if (status.task.status === "succeeded" && status.task.result) {
              const result = status.task.result;
              setDatabaseMaintenanceMessage(
                rebuildFts && result.ftsRebuilt
                  ? t(locale, "searchIndexRebuilt")
                  : t(locale, "databaseMaintenanceComplete", {
                      count: String(result.removedUndoSnapshots ?? 0),
                      bytes: formatBytes(
                        Math.max(
                          0,
                          (result.beforeBytes as number) - (result.afterBytes as number),
                        ),
                        locale,
                      ),
                    }),
              );
            } else if (status.task.status === "failed") {
              console.error("Maintenance task failed:", status.task.errorSummary);
              setDatabaseMaintenanceMessage(t(locale, "databaseMaintenanceFailed"));
            } else {
              // Still running — wait and retry.
              await new Promise((resolve) => setTimeout(resolve, 500));
              await poll();
            }
          };
          await poll();
        } catch (error) {
          console.error("Unable to maintain database", error);
          setDatabaseMaintenanceMessage(t(locale, "databaseMaintenanceFailed"));
        } finally {
          setMaintainingDatabase(false);
        }
      })();
    },
    [client, locale],
  );

  const testSyncConnection = useCallback(
    (serverUrl: string, timeoutSeconds: number) => {
      setTestingSyncConnection(true);
      setSyncConnectionMessage(undefined);
      void (async () => {
        const startedAt = performance.now();
        if (isDesktopApp) {
          // Desktop: route through main process proxy (no CSP bypass).
          await window.ygdria!.remote!.test(serverUrl.trim(), timeoutSeconds);
          setSyncConnectionMessage(
            `${t(locale, "connectionSucceeded")}（${Math.round(performance.now() - startedAt)} ms）`,
          );
          return;
        }
        // Browser: direct fetch (same-origin or CORS-permitted).
        let target: URL;
        try {
          target = new URL(serverUrl.trim());
          if (target.protocol !== "https:")
            throw new Error(t(locale, "syncRequiresHttps"));
        } catch (error) {
          throw error instanceof Error ? error : new Error(t(locale, "invalidServerUrl"));
        }
        target.pathname = `${target.pathname.replace(/\/$/, "")}/api/v1/health`;
        target.search = "";
        const controller = new AbortController();
        const timeout = window.setTimeout(
          () => controller.abort(),
          Math.max(1, timeoutSeconds) * 1_000,
        );
        try {
          const response = await fetch(target.toString(), { signal: controller.signal });
          if (!response.ok) throw new Error(t(locale, "httpError", { status: String(response.status) }));
          await response.json();
          setSyncConnectionMessage(
            `${t(locale, "connectionSucceeded")}（${Math.round(performance.now() - startedAt)} ms）`,
          );
        } finally {
          window.clearTimeout(timeout);
        }
      })()
        .catch((error) => {
          const detail = error instanceof Error ? error.message : t(locale, "unknownError");
          setSyncConnectionMessage(`${t(locale, "connectionFailed")}：${detail}`);
        })
        .finally(() => setTestingSyncConnection(false));
    },
    [isDesktopApp, locale],
  );

  return {
    clearingExcessRevisions,
    revisionCleanupMessage,
    maintainingDatabase,
    databaseMaintenanceMessage,
    databaseMaintenanceMessageTarget,
    testingSyncConnection,
    syncConnectionMessage,
    clearExcessRevisions,
    maintainDatabase,
    testSyncConnection,
  };
}