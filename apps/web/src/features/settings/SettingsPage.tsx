import { useState, type ChangeEvent, type ReactNode } from "react";
import { ListTree } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import { APP_VERSION } from "../../lib/appVersion";
import { readSettings, writeSettings, type StoredSettings, type TimeUnit } from "./settingsStore";

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
}) {
  const [settings, setSettings] = useState<StoredSettings>(readSettings);
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
      <h2 id="settings-security" className="settings-category">{t(locale, "settingsSecurity")}</h2>
      <SettingsSection id="settings-protected" title={t(locale, "protectedSession")} hint={t(locale, "protectedSessionHint")} rows={[
        <SettingsActionRow key="protected-password" title={t(locale, "changeProtectedPassword")} description={t(locale, "changeProtectedPasswordHint")} action={t(locale, "changeProtectedPassword")} disabled={!canChangeProtectedPassword} onClick={onChangeProtectedPassword} />,
        <SettingsNumberRow key="protected-timeout" title={t(locale, "protectedSessionTimeout")} description={t(locale, "protectedSessionHint")} value={protectedSessionTimeoutMinutes ?? 10} min={1} unit={t(locale, "minutes")} onChange={(event) => onProtectedSessionTimeoutChange?.(Number(event.target.value))} />,
      ]} />
    </article>;
}

function SettingsSection({ id, title, hint, rows }: { id?: string; title: string; hint?: string; rows: ReactNode[] }) {
  return <section id={id} className="settings-section"><h3>{title}</h3><div className="settings-card">{hint && <p className="settings-intro">{hint}</p>}{rows}</div></section>;
}

export function SettingsOutline({ locale }: { locale: Locale }) {
  const groups = [
    ["settings-general", t(locale, "settingsGeneral"), [["settings-language", t(locale, "settingsLanguage")], ["settings-about", t(locale, "about")], ["settings-sync", t(locale, "syncServer")]]],
    ["settings-data", t(locale, "settingsData"), [["settings-transfer", t(locale, "importExport")], ["settings-trash", t(locale, "deletedNotes")], ["settings-attachments", t(locale, "unusedAttachments")], ["settings-revisions", t(locale, "noteRevisions")], ["settings-database", t(locale, "databaseMaintenance")]]],
    ["settings-security", t(locale, "settingsSecurity"), [["settings-protected", t(locale, "protectedSession")]]],
  ] as const;
  return <aside className="note-inspector settings-outline"><div className="inspector-heading"><ListTree size={16} /> {t(locale, "onThisPage")}</div><ul className="outline-list">{groups.map(([id, label, sections]) => <li key={id}><button className="settings-outline-group" type="button" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{label}</button><ul>{sections.map(([sectionId, sectionLabel]) => <li key={sectionId}><button type="button" onClick={() => document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{sectionLabel}</button></li>)}</ul></li>)}</ul></aside>;
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
