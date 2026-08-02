import React from "react";
import {
  X, Pin, PinOff, Undo2, ExternalLink, CopyPlus,
} from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import type { WorkspaceTab } from "../../types/workspace";

type TabContextMenuProps = {
  menu: { tabId: string; x: number; y: number };
  tabs: WorkspaceTab[];
  pinnedTabIds: Set<string>;
  closedTabs: WorkspaceTab[];
  locale: Locale;
  hasWindowControls: boolean;
  onClose: () => void;
  onTogglePin: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseTabs: (tabIds: string[]) => void;
  onReopenClosedTab: () => void;
  onOpenInNewWindow: (tab: WorkspaceTab, move: boolean) => void;
};

export function TabContextMenu({
  menu, tabs, pinnedTabIds, closedTabs, locale, hasWindowControls,
  onClose, onTogglePin, onCloseTab, onCloseTabs, onReopenClosedTab, onOpenInNewWindow,
}: TabContextMenuProps) {
  const tab = tabs.find((item) => item.id === menu.tabId);
  if (!tab) return null;
  const tabIndex = tabs.findIndex((item) => item.id === tab.id);
  const canReopen = closedTabs.length > 0;

  return (
    <div
      className="action-menu tab-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={() => { onTogglePin(tab.id); onClose(); }}>
        {pinnedTabIds.has(tab.id) ? <PinOff size={16} /> : <Pin size={16} />}
        {t(locale, pinnedTabIds.has(tab.id) ? "unpinTab" : "pinTab")}
      </button>
      <div className="context-separator" />
      <button role="menuitem" disabled={pinnedTabIds.has(tab.id)} onClick={() => { onCloseTab(tab.id); onClose(); }}>
        <X size={16} /> {t(locale, "closeTab")}
      </button>
      <button role="menuitem" onClick={() => { onCloseTabs(tabs.filter((item) => item.id !== tab.id && !pinnedTabIds.has(item.id)).map((item) => item.id)); onClose(); }}>
        {t(locale, "closeOtherTabs")}
      </button>
      <button role="menuitem" onClick={() => { onCloseTabs(tabs.slice(tabIndex + 1).filter((item) => !pinnedTabIds.has(item.id)).map((item) => item.id)); onClose(); }}>
        {t(locale, "closeTabsToRight")}
      </button>
      <button role="menuitem" onClick={() => { onCloseTabs(tabs.filter((item) => !pinnedTabIds.has(item.id)).map((item) => item.id)); onClose(); }}>
        {t(locale, "closeAllTabs")}
      </button>
      <div className="context-separator" />
      <button role="menuitem" disabled={!canReopen} onClick={() => { onReopenClosedTab(); onClose(); }}>
        <Undo2 size={16} /> {t(locale, "reopenClosedTab")}
      </button>
      {hasWindowControls && (
        <>
          <div className="context-separator" />
          <button role="menuitem" onClick={() => { onOpenInNewWindow(tab, true); onClose(); }}>
            <ExternalLink size={16} /> {t(locale, "moveTabToNewWindow")}
          </button>
          <button role="menuitem" onClick={() => { onOpenInNewWindow(tab, false); onClose(); }}>
            <CopyPlus size={16} /> {t(locale, "copyTabToNewWindow")}
          </button>
        </>
      )}
    </div>
  );
}
