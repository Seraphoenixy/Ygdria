import { useState } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";

/** Slim top banner shown while the thin client cannot reach its server. */
export function ConnectionBanner({ locale, retry }: { locale: Locale; retry: () => Promise<boolean> }) {
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const onRetry = () => {
    setRetrying(true);
    setRetryFailed(false);
    void retry()
      .then((ok) => {
        if (!ok) setRetryFailed(true);
      })
      .finally(() => setRetrying(false));
  };
  return (
    <div className="connection-banner" role="status">
      <WifiOff size={15} aria-hidden="true" />
      <span>
        {t(locale, "connectionLost")}
        {retryFailed ? ` ${t(locale, "connectionRetryFailed")}` : ""}
      </span>
      <button type="button" disabled={retrying} onClick={onRetry}>
        <RefreshCw size={13} className={retrying ? "spinning" : ""} aria-hidden="true" />
        {retrying ? t(locale, "connectionRetrying") : t(locale, "connectionRetry")}
      </button>
    </div>
  );
}
