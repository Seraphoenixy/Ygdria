import { detectLocale, type Locale } from "../../lib/i18n";

export type TimeUnit = "seconds" | "minutes" | "hours" | "days";

/** User theme preference. "system" follows the OS `prefers-color-scheme`. */
export type ThemePreference = "light" | "dark" | "system";

export type StoredSettings = {
  locale: Locale;
  theme: ThemePreference;
  trashRetentionDays: number;
  trashRetentionUnit: TimeUnit;
  attachmentRetentionDays: number;
  attachmentRetentionUnit: TimeUnit;
  revisionIntervalMinutes: number;
  revisionIntervalUnit: TimeUnit;
  revisionLimit: number;
  transferFormat: "markdown" | "json";
  syncServerUrl: string;
  syncConnectionTimeoutSeconds: number;
};

const defaultSettings: StoredSettings = {
  locale: detectLocale(),
  theme: "system",
  trashRetentionDays: 7,
  trashRetentionUnit: "days",
  attachmentRetentionDays: 0,
  attachmentRetentionUnit: "days",
  revisionIntervalMinutes: 10,
  revisionIntervalUnit: "minutes",
  revisionLimit: 3,
  transferFormat: "markdown",
  syncServerUrl: "",
  syncConnectionTimeoutSeconds: 10,
};

export function readSettings(): StoredSettings {
  try {
    const saved = window.localStorage.getItem("ygdria.settings");
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function writeSettings(settings: StoredSettings) {
  window.localStorage.setItem("ygdria.settings", JSON.stringify(settings));
}
