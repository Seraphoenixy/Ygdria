import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";

export function DeviceAccessGate({
  initializing,
  onSubmit,
  onConnectExisting,
  migrationToEmptyServer = false,
  remoteRequiresHttps = false,
  onCheckClientMigration,
}: {
  initializing: boolean;
  onSubmit: (password: string, label: string) => Promise<void>;
  onConnectExisting?: (serverUrl: string, password: string, label: string) => Promise<void>;
  /** Desktop migration: initialize an empty HTTPS server from local data. */
  migrationToEmptyServer?: boolean;
  /** Desktop remote connections must never use an unencrypted origin. */
  remoteRequiresHttps?: boolean;
  /** Empty standalone server waits for a desktop client to migrate into it. */
  onCheckClientMigration?: () => Promise<void>;
}) {
  const [setupMode, setSetupMode] = useState<"new" | "existing">("new");
  const [serverUrl, setServerUrl] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [label, setLabel] = useState("当前浏览器");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const validPassword = password.length >= 8 && password.length <= 64;
  const connecting = initializing && setupMode === "existing";
  const waitingForClientMigration = connecting && Boolean(onCheckClientMigration) && !migrationToEmptyServer;
  const validServerUrl = (migrationToEmptyServer || remoteRequiresHttps) ? /^https:\/\/.+/.test(serverUrl.trim()) : /^https?:\/\/.+/.test(serverUrl.trim());
  const valid = waitingForClientMigration || (validPassword && label.trim().length > 0 && (!initializing || connecting || password === confirm) && (!connecting || validServerUrl));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(undefined);
    void (waitingForClientMigration ? onCheckClientMigration!() : connecting ? onConnectExisting!(serverUrl.trim().replace(/\/$/, ""), password, label.trim()) : onSubmit(password, label.trim()))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "认证失败，请重试。"))
      .finally(() => setSubmitting(false));
  };

  return (
    <main className="device-access-shell">
      <section className="device-access-card" aria-labelledby="device-access-title">
        <form onSubmit={handleSubmit}>
          <div className="device-access-icon"><LockKeyhole size={25} /></div>
          <div>
            <h1 id="device-access-title">{initializing ? (connecting ? (waitingForClientMigration ? "连接已有客户端" : migrationToEmptyServer ? "迁移到空白服务端" : "连接已有知识库") : "初始化服务") : "登录"}</h1>
            <p>
              {initializing
                ? connecting
                ? waitingForClientMigration
                  ? "请在已有桌面客户端选择“迁移到空白服务端”，输入本服务端的 HTTPS 地址并使用桌面已有主密码完成迁移。服务端不会反向连接或读取桌面设备。"
                  : migrationToEmptyServer
                    ? "使用本桌面知识库已有的主密码初始化空白服务端，再将本地数据首次同步过去。密码不会上传或保存。"
                    : "使用已有服务端的主密码完成安全认证，并将该知识库首次同步到此服务端。密码不会上传或保存。"
                  : "设置主密码以创建新的知识库。主密码仅在本机派生文件加密密钥与访问凭据，绝不上传；服务端只保存 PAKE 验证记录与随机盐。"
                : "输入主密码完成 PAKE 挑战响应以获取本次会话的设备令牌。"}
            </p>
          </div>
          {initializing && (onConnectExisting || onCheckClientMigration) && <div className="device-access-choice" role="group" aria-label="初始化方式">
            <button type="button" className={setupMode === "new" ? "active" : ""} onClick={() => { setSetupMode("new"); setError(undefined); }}>创建新知识库</button>
            <button type="button" className={setupMode === "existing" ? "active" : ""} onClick={() => { setSetupMode("existing"); setError(undefined); }}>{waitingForClientMigration ? "连接已有客户端" : migrationToEmptyServer ? "迁移到空白服务端" : "连接已有服务端"}</button>
          </div>}
          {connecting && !waitingForClientMigration && <label>
            <span>{migrationToEmptyServer ? "空白服务端地址（HTTPS）" : remoteRequiresHttps ? "已有服务端地址（HTTPS）" : "已有服务端地址"}</span>
            <input type="url" value={serverUrl} placeholder="https://notes.example.com" onChange={(event) => { setServerUrl(event.target.value); setError(undefined); }} />
          </label>}
          {!waitingForClientMigration && <label>
            <span>设备名称</span>
            <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
          </label>}
          {!waitingForClientMigration && <label>
            <span>{connecting ? migrationToEmptyServer ? "桌面已有主密码" : "已有服务端的主密码" : initializing ? "设置主密码" : "主密码"}</span>
            <input
              autoFocus
              type="password"
              minLength={8}
              maxLength={64}
              value={password}
              placeholder="8–64 位"
              onChange={(event) => { setPassword(event.target.value); setError(undefined); }}
            />
          </label>}
          {initializing && !connecting && !waitingForClientMigration && (
            <label>
              <span>确认主密码</span>
              <input
                type="password"
                maxLength={64}
                value={confirm}
                onChange={(event) => { setConfirm(event.target.value); setError(undefined); }}
              />
            </label>
          )}
          {error && <p className="device-access-error" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={!valid || submitting}
          >
            {submitting ? "处理中…" : waitingForClientMigration ? "已完成迁移，重新检查" : connecting ? migrationToEmptyServer ? "迁移并首次同步" : "连接并首次同步" : initializing ? "初始化并进入" : "认证并进入"}
          </button>
        </form>
      </section>
    </main>
  );
}
