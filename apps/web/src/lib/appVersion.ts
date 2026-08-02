const FALLBACK_VERSION = "0.1.0";

/** Version embedded by the release workflow; falls back for local development. */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION?.trim() || FALLBACK_VERSION;
