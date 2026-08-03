import { useEffect, useState, type FormEvent } from "react";
import { MAX_MASTER_PASSWORD_LENGTH } from "../../lib/client-crypto";
import { t, type Locale } from "../../lib/i18n";

export function MigrationToServerDialog({
  locale,
  onCancel,
  onSubmit,
}: {
  locale: Locale;
  onCancel: () => void;
  onSubmit: (serverUrl: string, password: string, label: string) => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState(t(locale, "deviceLabelDesktop"));
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const valid = /^https:\/\/.+/.test(serverUrl.trim()) && password.length >= 8 && password.length <= MAX_MASTER_PASSWORD_LENGTH && label.trim().length > 0 && confirmed;

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !submitting) onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel, submitting]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    void onSubmit(serverUrl.trim().replace(/\/$/, ""), password, label.trim())
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t(locale, "deviceAccessAuthFailed")))
      .finally(() => setSubmitting(false));
  };

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => !submitting && onCancel()}>
    <section className="confirm-dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title" onMouseDown={(event) => event.stopPropagation()}>
      <form onSubmit={handleSubmit}>
        <div>
          <h2 id="migration-title">{t(locale, "migrateDialogTitle")}</h2>
          <p>{t(locale, "migrateDialogDesc")}</p>
        </div>
        <input autoFocus type="url" value={serverUrl} placeholder={t(locale, "deviceAccessEmptyServerLabel")} onChange={(event) => { setServerUrl(event.target.value); setError(undefined); }} />
        <input type="text" value={label} maxLength={80} placeholder={t(locale, "deviceAccessDeviceName")} onChange={(event) => { setLabel(event.target.value); setError(undefined); }} />
        <input type="password" value={password} minLength={8} maxLength={MAX_MASTER_PASSWORD_LENGTH} placeholder={t(locale, "deviceAccessPasswordDesktop")} onChange={(event) => { setPassword(event.target.value); setError(undefined); }} />
        <label className="migration-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t(locale, "migrateConfirmEmpty")}</label>
        {error && <p className="password-dialog-error" role="alert">{error}</p>}
        <div className="confirm-dialog-actions">
          <button type="button" disabled={submitting} onClick={onCancel}>{t(locale, "cancel")}</button>
          <button type="submit" className="danger" disabled={!valid || submitting}>{submitting ? t(locale, "processing") : t(locale, "migrateButton")}</button>
        </div>
      </form>
    </section>
  </div>;
}
