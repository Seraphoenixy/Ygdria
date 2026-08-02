import { useEffect, useState, type FormEvent } from "react";
import { MAX_MASTER_PASSWORD_LENGTH } from "../../lib/client-crypto";
import { t, type Locale } from "../../lib/i18n";

export function PasswordDialog({ mode, locale, onCancel, onSubmit }: { mode: "setup" | "unlock" | "change" | "reauth"; locale: Locale; onCancel: () => void; onSubmit: (password: string, currentPassword?: string) => Promise<void> | void }) {
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const confirmRequired = mode !== "unlock" && mode !== "reauth";
  const valid = password.length >= 8 && password.length <= MAX_MASTER_PASSWORD_LENGTH && (!confirmRequired || password === confirm) && (mode !== "change" || currentPassword.length > 0);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [onCancel]);
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    Promise.resolve(onSubmit(password, mode === "change" ? currentPassword : undefined)).catch((error: unknown) => {
      setSubmitError(error instanceof Error ? error.message : t(locale, "deviceAccessAuthFailed"));
    }).finally(() => setSubmitting(false));
  };
  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={onCancel}><section className="confirm-dialog password-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
    <form onSubmit={handleSubmit}>
      <div><h2>{mode === "setup" ? t(locale, "passwordDialogSetup") : mode === "change" ? t(locale, "passwordDialogChange") : mode === "reauth" ? t(locale, "passwordDialogReauth") : t(locale, "passwordDialogUnlock")}</h2><p>{mode === "reauth" ? t(locale, "passwordDialogReauthDesc") : t(locale, "passwordDialogDesc")}</p></div>
      {mode === "change" && <input autoFocus type="password" maxLength={MAX_MASTER_PASSWORD_LENGTH} value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); setSubmitError(undefined); }} placeholder={t(locale, "passwordDialogCurrentPlaceholder")} />}
      <input autoFocus={mode !== "change"} type="password" maxLength={MAX_MASTER_PASSWORD_LENGTH} value={password} onChange={(event) => { setPassword(event.target.value); setSubmitError(undefined); }} placeholder={mode === "change" ? t(locale, "masterPasswordPlaceholderNew", { max: String(MAX_MASTER_PASSWORD_LENGTH) }) : t(locale, "masterPasswordPlaceholder", { max: String(MAX_MASTER_PASSWORD_LENGTH) })} />
      {confirmRequired && <input type="password" maxLength={MAX_MASTER_PASSWORD_LENGTH} value={confirm} onChange={(event) => { setConfirm(event.target.value); setSubmitError(undefined); }} placeholder={t(locale, "passwordDialogConfirmPlaceholder")} />}
      {submitError && <p className="password-dialog-error" role="alert">{submitError}</p>}
      <div className="confirm-dialog-actions"><button type="button" disabled={submitting} onClick={onCancel}>{t(locale, "cancel")}</button><button type="submit" className="danger" disabled={!valid || submitting}>{submitting ? t(locale, "processing") : mode === "setup" ? t(locale, "passwordDialogSet") : mode === "change" ? t(locale, "passwordDialogChangeButton") : mode === "reauth" ? t(locale, "passwordDialogReconnect") : t(locale, "passwordDialogUnlockButton")}</button></div>
    </form>
  </section></div>;
}
