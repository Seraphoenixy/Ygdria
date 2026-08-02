import { useEffect, useState, type FormEvent } from "react";
import { MAX_MASTER_PASSWORD_LENGTH } from "../../lib/client-crypto";

export function MigrationToServerDialog({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (serverUrl: string, password: string, label: string) => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("桌面端");
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
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "迁移失败，请重试。"))
      .finally(() => setSubmitting(false));
  };

  return <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={() => !submitting && onCancel()}>
    <section className="confirm-dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title" onMouseDown={(event) => event.stopPropagation()}>
      <form onSubmit={handleSubmit}>
        <div>
          <h2 id="migration-title">迁移本地知识库到空白服务端</h2>
          <p>目标必须是尚未初始化的 HTTPS 服务端。将使用当前主密码建立目标端访问凭据并首次同步本地数据；已有服务端不会被覆盖。</p>
        </div>
        <input autoFocus type="url" value={serverUrl} placeholder="空白服务端 HTTPS 地址" onChange={(event) => { setServerUrl(event.target.value); setError(undefined); }} />
        <input type="text" value={label} maxLength={80} placeholder="设备名称" onChange={(event) => { setLabel(event.target.value); setError(undefined); }} />
        <input type="password" value={password} minLength={8} maxLength={MAX_MASTER_PASSWORD_LENGTH} placeholder={`当前主密码（8–${MAX_MASTER_PASSWORD_LENGTH} 位）`} onChange={(event) => { setPassword(event.target.value); setError(undefined); }} />
        <label className="migration-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我确认目标服务端为空白服务端。</label>
        {error && <p className="password-dialog-error" role="alert">{error}</p>}
        <div className="confirm-dialog-actions">
          <button type="button" disabled={submitting} onClick={onCancel}>取消</button>
          <button type="submit" className="danger" disabled={!valid || submitting}>{submitting ? "正在迁移…" : "初始化并首次同步"}</button>
        </div>
      </form>
    </section>
  </div>;
}
