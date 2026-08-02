import { useEffect, useState, type FormEvent } from "react";
import { MAX_MASTER_PASSWORD_LENGTH } from "../../lib/client-crypto";

export function PasswordDialog({ mode, onCancel, onSubmit }: { mode: "setup" | "unlock" | "change" | "reauth"; onCancel: () => void; onSubmit: (password: string, currentPassword?: string) => Promise<void> | void }) {
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
      setSubmitError(error instanceof Error ? error.message : "无法完成受保护会话操作，请重试。");
    }).finally(() => setSubmitting(false));
  };
  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={onCancel}><section className="confirm-dialog password-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
    <form onSubmit={handleSubmit}>
      <div><h2>{mode === "setup" ? "设置主密码" : mode === "change" ? "更改主密码" : mode === "reauth" ? "服务器已重启" : "解锁受保护笔记"}</h2><p>{mode === "reauth" ? "远端设备令牌已失效。输入主密码以安全重新连接；密码不会上传或保存。" : "密码仅用于本机受保护会话，遗失后无法恢复加密笔记。"}</p></div>
      {mode === "change" && <input autoFocus type="password" maxLength={MAX_MASTER_PASSWORD_LENGTH} value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); setSubmitError(undefined); }} placeholder="当前主密码" />}
      <input autoFocus={mode !== "change"} type="password" maxLength={MAX_MASTER_PASSWORD_LENGTH} value={password} onChange={(event) => { setPassword(event.target.value); setSubmitError(undefined); }} placeholder={mode === "change" ? `新主密码（8–${MAX_MASTER_PASSWORD_LENGTH} 位）` : `主密码（8–${MAX_MASTER_PASSWORD_LENGTH} 位）`} />
      {confirmRequired && <input type="password" maxLength={MAX_MASTER_PASSWORD_LENGTH} value={confirm} onChange={(event) => { setConfirm(event.target.value); setSubmitError(undefined); }} placeholder="确认主密码" />}
      {submitError && <p className="password-dialog-error" role="alert">{submitError}</p>}
      <div className="confirm-dialog-actions"><button type="button" disabled={submitting} onClick={onCancel}>取消</button><button type="submit" className="danger" disabled={!valid || submitting}>{submitting ? "处理中…" : mode === "setup" ? "设置" : mode === "change" ? "更改" : mode === "reauth" ? "重新连接" : "解锁"}</button></div>
    </form>
  </section></div>;
}
