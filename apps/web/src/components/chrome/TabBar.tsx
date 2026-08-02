import React from "react";
import { Plus, Settings, Search, History, Archive, FileText, Paperclip, X } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement, WorkspaceTab } from "../../types/workspace";

type TabBarProps = {
  tabs: WorkspaceTab[];
  activeTabId?: string;
  pinnedTabIds: Set<string>;
  /** Resolve each note tab independently; inactive tabs must not reuse the active note title. */
  noteTitleForTab: (tab: Extract<WorkspaceTab, { kind: "note" }>) => string | undefined;
  locale: Locale;
  onActivate: (tab: WorkspaceTab) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onContextMenu: (tabId: string, x: number, y: number) => void;
};

export function TabBar({
  tabs, activeTabId, pinnedTabIds, noteTitleForTab, locale,
  onActivate, onClose, onNewTab, onContextMenu,
}: TabBarProps) {
  return (
    <div className="note-tabs" role="tablist" aria-label={t(locale, "notes")}>
      <div
        className="note-tabs-list"
        style={
          {
            "--tab-count": tabs.length,
            "--tab-list-width": `${tabs.length * 260}px`,
          } as React.CSSProperties
        }
      >
        {tabs.map((tab) => {
          const tabTitle = tab.kind === "settings"
            ? t(locale, "settingsTitle")
            : tab.kind === "search"
              ? t(locale, "searchTitle")
            : tab.kind === "history"
              ? t(locale, "recentChanges")
            : tab.kind === "archive"
              ? t(locale, "archivedNotes")
              : tab.kind === "attachments"
                ? t(locale, "attachments")
              : tab.kind === "new"
                  ? t(locale, "newTab")
                  : noteTitleForTab(tab) ?? t(locale, "loading");
          return (
            <div
              className={`note-tab ${activeTabId === tab.id ? "active" : ""}`}
              key={tab.id}
              role="tab"
              aria-selected={activeTabId === tab.id}
              tabIndex={0}
              onClick={() => onActivate(tab)}
              onKeyDown={(event) => event.key === "Enter" && onActivate(tab)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(tab.id, event.clientX, event.clientY);
              }}
            >
              {tab.kind === "settings" ? <Settings size={16} /> : tab.kind === "search" ? <Search size={16} /> : tab.kind === "history" ? <History size={16} /> : tab.kind === "archive" ? <Archive size={16} /> : tab.kind === "attachments" ? <Paperclip size={16} /> : <FileText size={16} />}
              <span>{tabTitle}</span>
              {!pinnedTabIds.has(tab.id) && (
                <button
                  className="note-tab-close"
                  aria-label={t(locale, "closeTab")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        className="note-tab-new"
        aria-label={t(locale, "newTab")}
        title={t(locale, "newTab")}
        onClick={onNewTab}
      >
        <Plus size={17} />
      </button>
    </div>
  );
}
