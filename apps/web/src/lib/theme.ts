import { readSettings, type ThemePreference } from "../features/settings/settingsStore";

export type { ThemePreference } from "../features/settings/settingsStore";
export type ResolvedTheme = "light" | "dark";

/** Resolve a user preference into the concrete theme the CSS should use. */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") {
    if (typeof window === "undefined" || !window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

/**
 * Push the active theme onto <html> as `data-theme`. The stylesheet already
 * authors `:root[data-theme="dark"]` rules across many files; until now nothing
 * ever set the attribute, so the dark theme was dead code. Calling this before
 * first paint (in main.tsx) avoids a flash of the wrong theme.
 */
export function applyTheme() {
  if (typeof document === "undefined") return;
  const pref = readSettings().theme ?? "system";
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}
