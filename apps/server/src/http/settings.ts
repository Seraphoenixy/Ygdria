import { recordChange, type SqliteDatabase } from "@ygdria/database";

export function isAuthInitialized(sqlite: SqliteDatabase): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM settings WHERE key='auth_srp_verifier'").get());
}

export function readSetting(sqlite: SqliteDatabase, key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key=?").get(key) as
    { value?: string } | undefined;
  return row?.value ?? null;
}

export function writeSetting(sqlite: SqliteDatabase, key: string, value: string, timestamp: number): void {
  const previous = sqlite
    .prepare("SELECT value,updated_at updatedAt FROM settings WHERE key=?")
    .get(key) as { value: string; updatedAt: number } | undefined;
  if (previous?.value === value && previous.updatedAt >= timestamp) return;
  sqlite
    .prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    )
    .run(key, value, timestamp);
  // Authentication and protected-session records are local security state,
  // never replication data. Recording them would expose their values through
  // /sync/changes and let a peer later replay an overwrite via /sync/push.
  if (!isSensitiveSettingKey(key)) recordChange(sqlite, "setting", key, "updated");
}

export function deleteSetting(sqlite: SqliteDatabase, key: string): void {
  if (sqlite.prepare("DELETE FROM settings WHERE key=?").run(key).changes) {
    if (!isSensitiveSettingKey(key)) recordChange(sqlite, "setting", key, "deleted");
  }
}

export function isSensitiveSettingKey(key: string): boolean {
  return (
    key.startsWith("auth_") ||
    key.startsWith("protected_session_") ||
    key.startsWith("server_access_password_")
  );
}