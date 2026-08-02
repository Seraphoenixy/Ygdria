import { useEffect, useRef, useState } from "react";
import type { WorkspaceTab } from "../types/workspace";

type UseWorkspaceTabsOptions = {
  /** Synchronizes the workspace view (selected note and edit state) with a tab. */
  onActivate: (tab: WorkspaceTab | undefined, editing: boolean) => void;
};

function readWindowTab(): WorkspaceTab | undefined {
  try {
    const raw = new URLSearchParams(window.location.search).get("ygdria-tab");
    if (!raw) return;
    const tab = JSON.parse(raw) as WorkspaceTab;
    if (!tab || typeof tab.id !== "string" || !["note", "settings", "search", "history", "archive", "attachments", "new"].includes(tab.kind)) return;
    if (tab.kind === "note" && (typeof tab.noteId !== "string" || typeof tab.isTrashed !== "boolean")) return;
    return tab;
  } catch {
    return;
  }
}

/** Owns tab lifecycle; the parent remains responsible for rendering the selected view. */
export function useWorkspaceTabs({ onActivate }: UseWorkspaceTabsOptions) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const [pinnedTabIds, setPinnedTabIds] = useState<Set<string>>(new Set());
  const [closedTabs, setClosedTabs] = useState<WorkspaceTab[]>([]);
  const newTabSequence = useRef(0);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const settingsOpen = activeTab?.kind === "settings";

  const activateTab = (tab: WorkspaceTab | undefined, editing = false) => {
    setActiveTabId(tab?.id);
    onActivate(tab, editing);
  };

  useEffect(() => {
    const tab = readWindowTab();
    if (!tab) return;
    setTabs([tab]);
    activateTab(tab);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const openNote = (noteId: string, isTrashed = false, editing = false, openInNewTab = false, placementId?: string) => {
    const id = `note:${noteId}:${isTrashed ? "trash" : "active"}`;
    const tab: WorkspaceTab = { id, kind: "note", noteId, isTrashed, placementId };
    const existing = tabs.find((item) => item.id === id);
    if (existing) {
      activateTab(existing, editing);
      return;
    }
    setTabs((current) => {
      const activeIndex = current.findIndex((item) => item.id === activeTabId);
      const active = current[activeIndex];
      if (!openInNewTab && active && !pinnedTabIds.has(active.id)) {
        return current.map((item, index) => (index === activeIndex ? tab : item));
      }
      return [...current, tab];
    });
    activateTab(tab, editing);
  };

  const openSingletonTab = (tab: Extract<WorkspaceTab, { kind: "settings" | "search" | "history" | "archive" | "attachments" }>) => {
    setTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
    activateTab(tab);
  };
  const openSettings = () => openSingletonTab({ id: "settings", kind: "settings" });
  const openSearch = () => openSingletonTab({ id: "search", kind: "search" });
  const openHistory = () => openSingletonTab({ id: "history", kind: "history" });
  const openArchive = () => openSingletonTab({ id: "archive", kind: "archive" });
  const openAttachments = () => openSingletonTab({ id: "attachments", kind: "attachments" });
  const openNewTab = () => {
    newTabSequence.current += 1;
    const tab: WorkspaceTab = { id: `new:${Date.now()}:${newTabSequence.current}`, kind: "new" };
    setTabs((current) => [...current, tab]);
    activateTab(tab);
  };

  const closeTab = (tabId: string, remember = true) => {
    if (pinnedTabIds.has(tabId)) return;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs.filter((tab) => tab.id !== tabId);
    setTabs(next);
    const closed = tabs[index];
    if (closed && remember) setClosedTabs((current) => [...current, closed].slice(-20));
    if (activeTabId === tabId) activateTab(next[index] ?? next[index - 1]);
  };
  const closeTabs = (tabIds: string[]) => {
    const ids = new Set(tabIds.filter((id) => !pinnedTabIds.has(id)));
    if (!ids.size) return;
    const closingIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const closed = tabs.filter((tab) => ids.has(tab.id));
    const next = tabs.filter((tab) => !ids.has(tab.id));
    setTabs(next);
    setClosedTabs((current) => [...current, ...closed].slice(-20));
    if (activeTabId && ids.has(activeTabId)) activateTab(next[closingIndex] ?? next[closingIndex - 1] ?? next.at(-1));
  };
  const togglePin = (tabId: string) => setPinnedTabIds((current) => {
    const next = new Set(current);
    next.has(tabId) ? next.delete(tabId) : next.add(tabId);
    return next;
  });
  const reopenClosedTab = () => {
    const tab = closedTabs.at(-1);
    if (!tab) return;
    setClosedTabs((current) => current.slice(0, -1));
    setTabs((current) => [...current, tab]);
    activateTab(tab);
  };
  const openTabInNewWindow = async (tab: WorkspaceTab, move = false) => {
    await window.ygdria?.openTabWindow?.(tab);
    if (move) closeTab(tab.id, false);
  };
  const clearTabs = () => {
    setTabs([]);
    activateTab(undefined);
  };

  return {
    tabs, activeTab, activeTabId, settingsOpen, pinnedTabIds, closedTabs,
    activateTab, openNote, openSettings, openSearch, openHistory, openArchive, openAttachments, openNewTab,
    closeTab, closeTabs, togglePin, reopenClosedTab, openTabInNewWindow, clearTabs,
  };
}
