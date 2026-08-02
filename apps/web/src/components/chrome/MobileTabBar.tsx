import React from "react";
import { Archive, FileText, History, Search, Settings as SettingsIcon } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";

type MobileTabBarProps = {
  locale: Locale;
  /** Whether the note-tree drawer is currently open. */
  treeOpen: boolean;
  onToggleTree: () => void;
  searchActive: boolean;
  onToggleSearch: () => void;
  historyActive: boolean;
  onToggleHistory: () => void;
  archiveActive: boolean;
  onToggleArchive: () => void;
  settingsActive: boolean;
  onToggleSettings: () => void;
};

/**
 * Bottom tab bar shown on phones (≤ 680px / native shell). It replaces the
 * desktop 48px shortcut rail and exposes the five primary destinations:
 * note tree, search, history, archive and settings. Every action that the
 * rail used to provide remains reachable (New / Today / Attachments live in
 * the tree drawer header; Lock lives in the top-bar overflow menu).
 */
export function MobileTabBar({
  locale,
  treeOpen,
  onToggleTree,
  searchActive,
  onToggleSearch,
  historyActive,
  onToggleHistory,
  archiveActive,
  onToggleArchive,
  settingsActive,
  onToggleSettings,
}: MobileTabBarProps) {
  return (
    <nav className="mobile-tab-bar" aria-label={t(locale, "mobileTabBar")}>
      <button
        type="button"
        className={`mobile-tab${treeOpen ? " active" : ""}`}
        aria-label={t(locale, "tabNotes")}
        aria-haspopup="true"
        aria-expanded={treeOpen}
        aria-controls="note-tree-panel"
        onClick={onToggleTree}
      >
        <FileText />
        <span>{t(locale, "tabNotes")}</span>
      </button>
      <button
        type="button"
        className={`mobile-tab${searchActive ? " active" : ""}`}
        aria-label={t(locale, "quickActionSearch")}
        aria-current={searchActive ? "page" : undefined}
        onClick={onToggleSearch}
      >
        <Search />
        <span>{t(locale, "quickActionSearch")}</span>
      </button>
      <button
        type="button"
        className={`mobile-tab${historyActive ? " active" : ""}`}
        aria-label={t(locale, "quickHistory")}
        aria-current={historyActive ? "page" : undefined}
        onClick={onToggleHistory}
      >
        <History />
        <span>{t(locale, "quickHistory")}</span>
      </button>
      <button
        type="button"
        className={`mobile-tab${archiveActive ? " active" : ""}`}
        aria-label={t(locale, "archivedNotes")}
        aria-current={archiveActive ? "page" : undefined}
        onClick={onToggleArchive}
      >
        <Archive />
        <span>{t(locale, "archivedNotes")}</span>
      </button>
      <button
        type="button"
        className={`mobile-tab${settingsActive ? " active" : ""}`}
        aria-label={t(locale, "quickSettings")}
        aria-current={settingsActive ? "page" : undefined}
        onClick={onToggleSettings}
      >
        <SettingsIcon />
        <span>{t(locale, "quickSettings")}</span>
      </button>
    </nav>
  );
}
