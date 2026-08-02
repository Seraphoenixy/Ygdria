import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";

export function DeviceAccessGate({
  initializing,
  onSubmit,
  onConnectExisting,
  migrationToEmptyServer = false,
  remoteRequiresHttps = false,
  onCheckClientMigration,
  locale,
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
  locale: Locale;
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

  const title = initializing
    ? connecting
      ? waitingForClientMigration
        ? t(locale, "deviceAccessConnectClient")
        : migrationToEmptyServer
          ? t(locale, "deviceAccessMigrateEmpty")
          : t(locale, "deviceAccessConnectExisting")
      : t(locale, "deviceAccessInitialize")
    : t(locale, "deviceAccessLogin");
  const description = initializing
    ? connecting
      ? waitingForClientMigration
        ? t(locale, "deviceAccessDescConnectClient")
        : migrationToEmptyServer
          ? t(locale, "deviceAccessDescMigrateEmpty")
          : t(locale, "deviceAccessDescConnect")
      : t(locale, "deviceAccessDescInit")
    : t(locale, "deviceAccessDescLogin");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(undefined);
    void (waitingForClientMigration ? onCheckClientMigration!() : connecting ? onConnectExisting!(serverUrl.trim().replace(/\/$/, ""), password, label.trim()) : onSubmit(password, label.trim()))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t(locale, "deviceAccessAuthFailed")))
      .finally(() => setSubmitting(false));
  };

  return (
    <main className="device-access-shell">
      <section className="device-access-card" aria-labelledby="device-access-title">
        <form onSubmit={handleSubmit}>
          <div className="device-access-icon"><LockKeyhole size={25} /></div>
          <div>
            <h1 id="device-access-title">{title}</h1>
            <p>{description}</p>
          </div>
          {initializing && (onConnectExisting || onCheckClientMigration) && <div className="device-access-choice" role="group" aria-label={t(locale, "deviceAccessChoiceLabel")}>
            <button type="button" className={setupMode === "new" ? "active" : ""} onClick={() => { setSetupMode("new"); setError(undefined); }}>{t(locale, "deviceAccessNewVault")}</button>
            <button type="button" className={setupMode === "existing" ? "active" : ""} onClick={() => { setSetupMode("existing"); setError(undefined); }}>{waitingForClientMigration ? t(locale, "deviceAccessConnectClient") : migrationToEmptyServer ? t(locale, "deviceAccessMigrateEmpty") : t(locale, "deviceAccessConnectServer")}</button>
          </div>}
          {connecting && !waitingForClientMigration && <label>
            <span>{migrationToEmptyServer ? t(locale, "deviceAccessEmptyServerLabel") : remoteRequiresHttps ? t(locale, "deviceAccessServerLabelHttps") : t(locale, "deviceAccessServerLabel")}</span>
            <input type="url" value={serverUrl} placeholder="https://notes.example.com" onChange={(event) => { setServerUrl(event.target.value); setError(undefined); }} />
          </label>}
          {!waitingForClientMigration && <label>
            <span>{t(locale, "deviceAccessDeviceName")}</span>
            <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
          </label>}
          {!waitingForClientMigration && <label>
            <span>{connecting ? migrationToEmptyServer ? t(locale, "deviceAccessPasswordDesktop") : t(locale, "deviceAccessPasswordConnect") : initializing ? t(locale, "deviceAccessPasswordNew") : t(locale, "deviceAccessPassword")}</span>
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
              <span>{t(locale, "deviceAccessConfirmPassword")}</span>
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
            {submitting ? t(locale, "processing") : waitingForClientMigration ? t(locale, "deviceAccessSubmitRecheck") : connecting ? migrationToEmptyServer ? t(locale, "deviceAccessSubmitMigrate") : t(locale, "deviceAccessSubmitConnect") : initializing ? t(locale, "deviceAccessSubmitInit") : t(locale, "deviceAccessSubmitLogin")}
          </button>
        </form>
      </section>
    </main>
  );
}
