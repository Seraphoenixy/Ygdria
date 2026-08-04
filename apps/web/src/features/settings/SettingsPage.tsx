import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { ListTree } from "lucide-react";
import type { EtapiScope, EtapiSession, YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import { APP_VERSION } from "../../lib/appVersion";
import { readSettings, writeSettings, type StoredSettings, type ThemePreference, type TimeUnit } from "./settingsStore";
import { applyTheme } from "../../lib/theme";

export { readSettings, type StoredSettings, type TimeUnit } from "./settingsStore";

export function SettingsPage({
  locale,
  onLocaleChange,
  purgingTrash,
  onPurgeTrash,
  clearingUnusedAttachments,
  onClearUnusedAttachments,
  clearingExcessRevisions,
  revisionCleanupMessage,
  onClearExcessRevisions,
  maintainingDatabase,
  onMaintainDatabase,
  databaseMaintenanceMessage,
  databaseMaintenanceMessageTarget,
  protectedSessionTimeoutMinutes,
  onProtectedSessionTimeoutChange,
  canChangeProtectedPassword = false,
  onChangeProtectedPassword,
  testingSyncConnection = false,
  syncConnectionMessage,
  onTestSyncConnection,
  canMigrateToEmptyServer = false,
  onMigrateToEmptyServer,
  canOpenFrontendConsole = false,
  onOpenFrontendConsole,
  syncRunsAutomatically = false,
  canEditMobileEndpoint = false,
  etapiTokenManagementAvailable = false,
  client,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  purgingTrash: boolean;
  onPurgeTrash: () => void;
  clearingUnusedAttachments?: boolean;
  onClearUnusedAttachments?: () => void;
  clearingExcessRevisions?: boolean;
  revisionCleanupMessage?: string;
  onClearExcessRevisions?: (limit: number) => void;
  maintainingDatabase?: boolean;
  onMaintainDatabase?: (rebuildFts?: boolean) => void;
  databaseMaintenanceMessage?: string;
  databaseMaintenanceMessageTarget?: "compact" | "fts";
  protectedSessionTimeoutMinutes?: number;
  onProtectedSessionTimeoutChange?: (minutes: number) => void;
  canChangeProtectedPassword?: boolean;
  onChangeProtectedPassword?: () => void;
  testingSyncConnection?: boolean;
  syncConnectionMessage?: string;
  onTestSyncConnection?: (url: string, timeoutSeconds: number) => void;
  canMigrateToEmptyServer?: boolean;
  onMigrateToEmptyServer?: () => void;
  canOpenFrontendConsole?: boolean;
  onOpenFrontendConsole?: () => void;
  syncRunsAutomatically?: boolean;
  canEditMobileEndpoint?: boolean;
  /** True when this is the desktop app's local ETAPI server. */
  etapiTokenManagementAvailable?: boolean;
  client: YgdriaClient;
}) {
  // `syncServerUrl` used to be initialized exclusively from localStorage, so
  // the settings page could show a stale address even after the client had
  // connected to another server. The active client's endpoint is authoritative.
  const activeServerUrl = displayServerUrl(client.getServerUrl());
  const [settings, setSettings] = useState<StoredSettings>(() => {
    const saved = readSettings();
    return activeServerUrl ? { ...saved, syncServerUrl: activeServerUrl } : saved;
  });
  useEffect(() => {
    if (!activeServerUrl) return;
    setSettings((current) => {
      if (current.syncServerUrl === activeServerUrl) return current;
      const updated = { ...current, syncServerUrl: activeServerUrl };
      writeSettings(updated);
      return updated;
    });
  }, [activeServerUrl]);
  const updateSettings = (next: Partial<StoredSettings>) => {
    const updated = { ...settings, ...next };
    setSettings(updated);
    writeSettings(updated);
  };
  const reconnectMobileEndpoint = () => {
    if (!canEditMobileEndpoint) return;
    try {
      const url = new URL(settings.syncServerUrl.trim());
      if (url.protocol === "http:" || url.protocol === "https:") window.location.reload();
    } catch {
      // Preserve the entered value so the user can complete or correct it.
    }
  };
  const numberInput = (key: keyof StoredSettings) => (event: ChangeEvent<HTMLInputElement>) =>
    updateSettings({ [key]: Number(event.target.value) } as Partial<StoredSettings>);

  return <article className="settings-page">
      <h1>{t(locale, "settingsTitle")}</h1>
      <h2 id="settings-general" className="settings-category">{t(locale, "settingsGeneral")}</h2>
      <section id="settings-language" className="settings-section">
        <h3>{t(locale, "settingsLanguage")}</h3>
        <div className="settings-card"><div className="settings-row">
          <div><strong>{t(locale, "settingsLanguage")}</strong><p>{t(locale, "settingsLanguageHint")}</p></div>
          <select className="settings-select" value={settings.locale} onChange={(event) => {
            const nextLocale = event.target.value as Locale;
            updateSettings({ locale: nextLocale });
            onLocaleChange(nextLocale);
          }}>
            <option value="zh-CN">简体中文</option><option value="en">English</option>
          </select>
        </div></div>
      </section>
      <section id="settings-about" className="settings-section">
        <h3>{t(locale, "about")}</h3>
        <div className="settings-card"><div className="settings-row">
          <div><strong>{t(locale, "appVersion")}</strong><p>{t(locale, "appVersionHint")}</p></div>
          <output className="settings-version">v{APP_VERSION}</output>
        </div></div>
      </section>
      <section id="settings-appearance" className="settings-section">
        <h3>{t(locale, "theme")}</h3>
        <div className="settings-card"><div className="settings-row">
          <div><strong>{t(locale, "theme")}</strong><p>{t(locale, "themeHint")}</p></div>
          <select
            className="settings-select"
            value={settings.theme}
            onChange={(event) => {
              const next = event.target.value as ThemePreference;
              updateSettings({ theme: next });
              applyTheme();
            }}
          >
            <option value="light">{t(locale, "themeLight")}</option>
            <option value="dark">{t(locale, "themeDark")}</option>
            <option value="system">{t(locale, "themeSystem")}</option>
          </select>
        </div></div>
      </section>
      <h2 id="settings-connection" className="settings-category">{t(locale, "settingsConnection")}</h2>
      <SettingsSection id="settings-sync" title={t(locale, "syncServer")} hint={t(locale, "syncServerHint")} rows={[
        <SettingsTextRow key="sync-server-url" title={t(locale, "syncServerUrl")} description={t(locale, "syncServerUrlHint")} value={settings.syncServerUrl} placeholder="https://notes.example.com" onChange={(value) => updateSettings({ syncServerUrl: value })} onBlur={reconnectMobileEndpoint} />,
        <SettingsNumberRow key="sync-timeout" title={t(locale, "syncConnectionTimeout")} description={t(locale, "syncServerHint")} value={settings.syncConnectionTimeoutSeconds} min={1} unit={t(locale, "seconds")} onChange={(event) => updateSettings({ syncConnectionTimeoutSeconds: Math.max(1, Math.floor(Number(event.target.value)) || 1) })} />,
        <SettingsActionRow key="sync-test" title={t(locale, "testConnection")} description={t(locale, "testConnectionHint")} action={t(locale, "testConnection")} disabled={!settings.syncServerUrl.trim() || testingSyncConnection} onClick={() => onTestSyncConnection?.(settings.syncServerUrl, settings.syncConnectionTimeoutSeconds)} status={syncConnectionMessage} />,
        ...(canMigrateToEmptyServer ? [<SettingsActionRow key="sync-migrate-empty" title={t(locale, "migrateLocalVault")} description={t(locale, "migrateLocalVaultDesc")} action={t(locale, "migrateToEmptyServer")} onClick={onMigrateToEmptyServer} />] : []),
        ...(canOpenFrontendConsole ? [<SettingsActionRow key="open-frontend-console" title={t(locale, "openFrontendConsole")} description={t(locale, "openFrontendConsoleDesc")} action={t(locale, "openConsole")} onClick={onOpenFrontendConsole} />] : []),
        ...(syncRunsAutomatically ? [<div key="sync-auto-hint" className="settings-row settings-info"><p>{t(locale, "syncAutoHint")}</p></div>] : []),
      ]} />
      <h2 id="settings-data" className="settings-category">{t(locale, "settingsData")}</h2>
      <section id="settings-transfer" className="settings-section">
        <h3>{t(locale, "importExport")}</h3>
        <div className="settings-card"><div className="settings-row">
          <div><strong>{t(locale, "transferFormat")}</strong><p>{t(locale, "transferFormatHint")}</p></div>
          <select className="settings-select" value={settings.transferFormat} onChange={(event) => updateSettings({ transferFormat: event.target.value as StoredSettings["transferFormat"] })}>
            <option value="markdown">Markdown</option><option value="json">JSON</option>
          </select>
        </div></div>
      </section>
      <SettingsSection id="settings-trash" title={t(locale, "deletedNotes")} hint={t(locale, "deletedNotesHint")} rows={[
        <SettingsNumberRow key="trash-retention" title={t(locale, "clearAfter")} description={t(locale, "deletedNotesHint")} value={settings.trashRetentionDays} unit={settings.trashRetentionUnit} onChange={numberInput("trashRetentionDays")} onUnitChange={(unit) => updateSettings({ trashRetentionUnit: unit })} locale={locale} />,
        <SettingsActionRow key="trash-clean" title={t(locale, "clearDeletedNotes")} description={t(locale, "clearNow")} action={t(locale, "clearNow")} disabled={purgingTrash} onClick={onPurgeTrash} />,
      ]} />
      <SettingsSection id="settings-attachments" title={t(locale, "unusedAttachments")} hint={t(locale, "unusedAttachmentsHint")} rows={[
        <SettingsNumberRow key="attachment-retention" title={t(locale, "clearAfter")} description={t(locale, "unusedAttachmentsHint")} value={settings.attachmentRetentionDays} unit={settings.attachmentRetentionUnit} onChange={numberInput("attachmentRetentionDays")} onUnitChange={(unit) => updateSettings({ attachmentRetentionUnit: unit })} locale={locale} />,
        <SettingsActionRow key="attachment-clean" title={t(locale, "clearUnusedAttachments")} description={t(locale, "unusedAttachmentsHint")} action={t(locale, "clearNow")} disabled={clearingUnusedAttachments} onClick={onClearUnusedAttachments} />,
      ]} />
      <SettingsSection id="settings-revisions" title={t(locale, "noteRevisions")} rows={[
        <SettingsNumberRow key="revision-interval" title={t(locale, "snapshotInterval")} description={t(locale, "snapshotIntervalHint")} value={settings.revisionIntervalMinutes} unit={settings.revisionIntervalUnit} onChange={numberInput("revisionIntervalMinutes")} onUnitChange={(unit) => updateSettings({ revisionIntervalUnit: unit })} locale={locale} />,
        <SettingsNumberRow key="revision-limit" title={t(locale, "revisionLimit")} description={t(locale, "revisionLimitHint")} value={settings.revisionLimit} unit={t(locale, "notes")} onChange={numberInput("revisionLimit")} />,
        <SettingsActionRow key="revision-clean" title={t(locale, "clearExcessRevisions")} description={t(locale, "revisionLimitHint")} action={t(locale, "clearNow")} disabled={clearingExcessRevisions || !Number.isInteger(settings.revisionLimit) || settings.revisionLimit < 0} onClick={() => onClearExcessRevisions?.(settings.revisionLimit)} status={revisionCleanupMessage} />,
      ]} />
      <SettingsSection id="settings-database" title={t(locale, "databaseMaintenance")} hint={t(locale, "databaseMaintenanceHint")} rows={[
        <SettingsActionRow key="database-maintenance" title={t(locale, "compactDatabase")} description={t(locale, "databaseMaintenanceHint")} action={t(locale, "compactDatabase")} disabled={maintainingDatabase} onClick={() => onMaintainDatabase?.(false)} status={databaseMaintenanceMessageTarget === "compact" ? databaseMaintenanceMessage : undefined} />,
        <SettingsActionRow key="search-index-rebuild" title={t(locale, "rebuildSearchIndex")} description={t(locale, "rebuildSearchIndexHint")} action={t(locale, "rebuildSearchIndex")} disabled={maintainingDatabase} onClick={() => onMaintainDatabase?.(true)} status={databaseMaintenanceMessageTarget === "fts" ? databaseMaintenanceMessage : undefined} />,
      ]} />
      <h2 id="settings-security" className="settings-category">{t(locale, "settingsSecurityAndAi")}</h2>
      <SettingsSection id="settings-protected" title={t(locale, "protectedSession")} hint={t(locale, "protectedSessionHint")} rows={[
        <SettingsActionRow key="protected-password" title={t(locale, "changeProtectedPassword")} description={t(locale, "changeProtectedPasswordHint")} action={t(locale, "changeProtectedPassword")} disabled={!canChangeProtectedPassword} onClick={onChangeProtectedPassword} />,
        <SettingsNumberRow key="protected-timeout" title={t(locale, "protectedSessionTimeout")} description={t(locale, "protectedSessionHint")} value={protectedSessionTimeoutMinutes ?? 10} min={1} unit={t(locale, "minutes")} onChange={(event) => onProtectedSessionTimeoutChange?.(Number(event.target.value))} />,
      ]} />
      <EtapiTokenSettings
        locale={locale}
        client={client}
        available={etapiTokenManagementAvailable}
      />
    </article>;
}

function SettingsSection({ id, title, hint, rows }: { id?: string; title: string; hint?: string; rows: ReactNode[] }) {
  return <section id={id} className="settings-section"><h3>{title}</h3><div className="settings-card">{hint && <p className="settings-intro">{hint}</p>}{rows}</div></section>;
}

export function SettingsOutline({ locale }: { locale: Locale }) {
  const groups = [
    ["settings-general", t(locale, "settingsGeneral"), [["settings-language", t(locale, "settingsLanguage")], ["settings-appearance", t(locale, "settingsAppearance")], ["settings-about", t(locale, "about")]]],
    ["settings-connection", t(locale, "settingsConnection"), [["settings-sync", t(locale, "syncServer")]]],
    ["settings-data", t(locale, "settingsData"), [["settings-transfer", t(locale, "importExport")], ["settings-trash", t(locale, "deletedNotes")], ["settings-attachments", t(locale, "unusedAttachments")], ["settings-revisions", t(locale, "noteRevisions")], ["settings-database", t(locale, "databaseMaintenance")]]],
    ["settings-security", t(locale, "settingsSecurityAndAi"), [["settings-protected", t(locale, "protectedSession")], ["settings-etapi", t(locale, "etapiTokens")]]],
  ] as const;
  return <aside className="note-inspector settings-outline"><div className="inspector-heading"><ListTree size={16} /> {t(locale, "onThisPage")}</div><ul className="outline-list">{groups.map(([id, label, sections]) => <li key={id}><button className="settings-outline-group" type="button" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{label}</button><ul>{sections.map(([sectionId, sectionLabel]) => <li key={sectionId}><button type="button" onClick={() => document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{sectionLabel}</button></li>)}</ul></li>)}</ul></aside>;
}

function displayServerUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (value) return value.replace(/\/$/, "");
  // Same-origin browser deployments use an empty base URL in the API client.
  return typeof window === "undefined" ? "" : window.location.origin;
}

function EtapiTokenSettings({ locale, client, available }: { locale: Locale; client: YgdriaClient; available: boolean }) {
  const [label, setLabel] = useState("AI assistant");
  const [scopes, setScopes] = useState<EtapiScope[]>(["notes:read"]);
  const [ttlSeconds, setTtlSeconds] = useState(15 * 60);
  const [sessions, setSessions] = useState<EtapiSession[]>([]);
  const [createdToken, setCreatedToken] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!available) return;
    setLoading(true);
    try {
      setSessions((await client.listEtapiSessions()).sessions);
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [available, client]);

  const toggleScope = (scope: EtapiScope) => {
    setScopes((current) => current.includes(scope)
      ? (current.length === 1 ? current : current.filter((item) => item !== scope))
      : [...current, scope]);
  };
  const create = async () => {
    if (!label.trim() || scopes.length === 0) return;
    setLoading(true);
    try {
      const issued = await client.createEtapiSession({ label: label.trim(), scopes, ttlSeconds });
      setCreatedToken(issued.accessToken);
      setSessions((current) => [issued, ...current.filter((session) => session.id !== issued.id)]);
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  const revoke = async (id: string) => {
    setLoading(true);
    try {
      await client.revokeEtapiSession(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  const copy = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setMessage(t(locale, "etapiTokenCopied"));
    } catch {
      setMessage(t(locale, "etapiCopyFailed"));
    }
  };

  return <section id="settings-etapi" className="settings-section">
    <h3>{t(locale, "etapiTokens")}</h3>
    <div className="settings-card">
      <p className="settings-intro">{available ? t(locale, "etapiTokensHint") : t(locale, "etapiTokensUnavailable")}</p>
      {available && <>
        <div className="settings-row settings-etapi-form">
          <div>
            <strong>{t(locale, "etapiNewToken")}</strong>
            <p>{t(locale, "etapiTokenWarning")}</p>
            <label className="settings-etapi-label">{t(locale, "etapiTokenLabel")}<input className="settings-text-control" value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} /></label>
            <fieldset className="settings-etapi-scopes"><legend>{t(locale, "etapiPermissions")}</legend>
              {(["notes:read", "notes:write"] as EtapiScope[]).map((scope) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} /> {t(locale, scope === "notes:read" ? "etapiRead" : "etapiWrite")}</label>)}
            </fieldset>
          </div>
          <div className="settings-etapi-actions"><label>{t(locale, "etapiExpiry")}<select className="settings-select" value={ttlSeconds} onChange={(event) => setTtlSeconds(Number(event.target.value))}><option value={15 * 60}>{t(locale, "etapi15Minutes")}</option><option value={30 * 60}>{t(locale, "etapi30Minutes")}</option><option value={60 * 60}>{t(locale, "etapi1Hour")}</option><option value={8 * 60 * 60}>{t(locale, "etapi8Hours")}</option></select></label><button className="settings-action" disabled={loading || !label.trim()} onClick={() => void create()}>{t(locale, "etapiCreateToken")}</button></div>
        </div>
        {createdToken && <div className="settings-row settings-etapi-issued"><div><strong>{t(locale, "etapiTokenCreated")}</strong><p>{t(locale, "etapiTokenOnce")}</p><input className="settings-text-control settings-etapi-secret" readOnly value={createdToken} aria-label={t(locale, "etapiTokenCreated")} /></div><button className="settings-action" onClick={() => void copy()}>{t(locale, "copy")}</button></div>}
        <div className="settings-row settings-etapi-list"><div><strong>{t(locale, "etapiActiveTokens")}</strong><p>{t(locale, "etapiActiveTokensHint")}</p>{message && <p className="settings-status" role="status">{message}</p>}{sessions.length > 0 && <ul>{sessions.map((session) => <li key={session.id}><span><b>{session.label}</b> · {session.scopes.join(", ")} · {t(locale, "etapiExpiresAt")} {new Date(session.expiresAt).toLocaleString(locale)}</span><button className="settings-action" disabled={loading} onClick={() => void revoke(session.id)}>{t(locale, "revoke")}</button></li>)}</ul>}</div><button className="settings-action" disabled={loading} onClick={() => void load()}>{t(locale, "refresh")}</button></div>
      </>}
    </div>
  </section>;
}

function SettingsNumberRow({ title, description, value, min, unit, onChange, onUnitChange, locale }: {
  title: string; description: string; value: number; unit: TimeUnit | string;
  min?: number;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void; onUnitChange?: (unit: TimeUnit) => void; locale?: Locale;
}) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><label className="settings-number-control">
    <input type="number" min={min} value={value} onChange={onChange} />
    {onUnitChange && locale ? <select value={unit} onChange={(event) => onUnitChange(event.target.value as TimeUnit)}>
      <option value="seconds">{t(locale, "seconds")}</option><option value="minutes">{t(locale, "minutes")}</option><option value="hours">{t(locale, "hours")}</option><option value="days">{t(locale, "days")}</option>
    </select> : <span>{unit}</span>}
  </label></div>;
}

function SettingsTextRow({ title, description, value, placeholder, onChange, onBlur }: { title: string; description: string; value: string; placeholder: string; onChange: (value: string) => void; onBlur?: () => void }) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><input className="settings-text-control" type="url" inputMode="url" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} /></div>;
}

function SettingsActionRow({ title, description, action, disabled = false, onClick, status }: {
  title: string; description: string; action: string; disabled?: boolean; onClick?: () => void; status?: string;
}) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p>{status && <p className="settings-status" role="status">{status}</p>}</div><button className="settings-action" disabled={disabled} onClick={onClick}>{action}</button></div>;
}
