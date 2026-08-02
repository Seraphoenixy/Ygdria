import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, ChevronsLeft, FilePlus2, History, Settings, Archive, Calendar, Lock, Unlock, RefreshCw, CloudCheck, CloudUpload, Paperclip, Home } from "lucide-react";
import { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement, WorkspaceTab } from "../../types/workspace";
import { NoteTree } from "./NoteTree";
import { computeAutoExpansion } from "../../lib/tree-paths";

function QuickButton({ label, active = false, className = "", disabled = false, onClick, children }: {
  label: string;
  active?: boolean;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return <button className={`quickbar-button ${active ? "active" : ""} ${className}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

type TreePanelProps = {
  client: YgdriaClient;
  locale: Locale;
  tree: TreePlacement[];
  tabs: WorkspaceTab[];
  selected?: string;
  selectedPlacementId?: string;
  selectedPlacementIds: Set<string>;
  selectionParentId: string | null | undefined;
  selectionAnchorId: string | undefined;
  treeClipboard: { placements: TreePlacement[]; mode: "cut" | "copy" } | null;
  activeTabId?: string;
  settingsOpen: boolean;
  collapsed: boolean;
  panelWidth: number;
  creatingNote: boolean;
  onCreateNote: (parentPlacementId?: string, type?: "text" | "code") => void;
  onSelectPlacement: (placement: TreePlacement, event: React.MouseEvent<HTMLElement>) => void;
  onToggleExpand: (placementId: string) => void;
  onContextMenu: (placement: TreePlacement, x: number, y: number) => void;
  onSetClipboard: (clipboard: { placements: TreePlacement[]; mode: "cut" | "copy" } | null) => void;
  onMovePlacement: (placementId: string, parentPlacementId: string, position: number) => void;
  onResizePanel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onToggleCollapse: () => void;
  onOpenHistory: () => void;
  onCloseHistory: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onCloseSettings: () => void;
  onOpenArchive: () => void;
  onOpenAttachments: () => void;
  onCloseAttachments: () => void;
  protectedSession: { configured: boolean; unlocked: boolean };
  onProtectedSessionToggle: () => void;
  onOpenTodayNote: () => void;
  syncing: boolean;
  syncState: "unconfigured" | "synced" | "pending";
  syncProgress?: string;
  onSync: () => void;
  onClearTabs: () => void;
  refreshTree: () => void;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  openImportDialog: (targetPlacementId: string) => void;
  exportPlacements: (placements: TreePlacement[]) => Promise<void>;
  importNotes: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  /** Decrypted titles for protected notes (noteId -> title). Empty when locked. */
  decryptedTitles: Map<string, string>;
};

export function TreePanel({
  client, locale, tree, tabs, selected, selectedPlacementId, selectedPlacementIds,
  selectionParentId, selectionAnchorId, treeClipboard, activeTabId, settingsOpen,
  collapsed, panelWidth, creatingNote, onCreateNote, onSelectPlacement, onToggleExpand,
  onContextMenu, onSetClipboard, onMovePlacement, onResizePanel, onToggleCollapse,
  onOpenHistory, onCloseHistory, onOpenSettings, onOpenSearch, onCloseSearch, onCloseSettings, onOpenArchive,
  onOpenAttachments, onCloseAttachments,
  protectedSession, onProtectedSessionToggle,
  onOpenTodayNote, syncing, syncState, syncProgress, onSync, onClearTabs, refreshTree, importInputRef, openImportDialog, exportPlacements, importNotes,
  decryptedTitles,
}: TreePanelProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  const childrenByParent = useMemo(() => {
    const byParent = new Map<string | null, TreePlacement[]>();
    for (const placement of tree) {
      const key = placement.parentPlacementId ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), placement]);
    }
    return byParent;
  }, [tree]);

  // Build lookup maps for tree-path calculations.
  const byId = useMemo(() => new Map(tree.map((item: TreePlacement) => [item.placementId, item])), [tree]);
  const byNoteId = useMemo(() => {
    const map = new Map<string, TreePlacement[]>();
    for (const item of tree) {
      map.set(item.noteId, [...(map.get(item.noteId) ?? []), item]);
    }
    return map;
  }, [tree]);

  // Root placements that must always stay expanded.
  const rootIds = useMemo(
    () => new Set(
      tree
        .filter((item) => item.parentPlacementId === null || item.isSystem || item.isCalendar)
        .map((item) => item.placementId),
    ),
    [tree],
  );

  const isSearching = search.trim().length > 0;

  const matchesSearch = (placement: TreePlacement): boolean => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return true;
    const title = placement.isProtected
      ? (decryptedTitles.get(placement.noteId) ?? "")
      : placement.title;
    if (title.toLocaleLowerCase().includes(term)) return true;
    return (childrenByParent.get(placement.placementId) ?? []).some(matchesSearch);
  };

  // ── Auto-expansion from open note tabs ──────────────────────────────
  // Whenever tabs or tree change, compute the union of ancestor chains for
  // all open note tabs and set that as the expansion state.
  useEffect(() => {
    if (isSearching) return; // Don't auto-recalc during search — search has its own expanded view.

    const openNoteInfos = tabs
      .filter((tab): tab is Extract<WorkspaceTab, { kind: "note" }> => tab.kind === "note")
      .map((tab) => ({ noteId: tab.noteId, placementId: tab.placementId }));

    const autoSet = computeAutoExpansion(openNoteInfos, byId, byNoteId, rootIds);
    setExpanded(autoSet);
    setUserExpanded(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, tree, isSearching]);

  // ── Search temporary expansion ──────────────────────────────────────
  // When searching, temporarily expand ancestors of all matching items so
  // they are visible in the tree. Uses matchesSearch (which includes
  // descendant matches) so ancestors of indirectly matching nodes are also
  // expanded. When search is cleared, the auto-expansion effect above kicks
  // back in.
  const searchExpanded = useMemo(() => {
    if (!isSearching) return null;
    const temp = new Set<string>();
    for (const placement of tree) {
      if (matchesSearch(placement)) {
        temp.add(placement.placementId);
        let parentId = placement.parentPlacementId;
        while (parentId) {
          temp.add(parentId);
          parentId = byId.get(parentId)?.parentPlacementId ?? null;
        }
      }
    }
    return temp;
  }, [isSearching, tree, byId, matchesSearch]);

  // Merge auto/auto+user expansion with search expansion.
  const effectiveExpanded = useMemo(() => {
    if (searchExpanded) return searchExpanded;
    // Merge user toggles on top of auto-expansion.
    if (userExpanded.size === 0) return expanded;
    const merged = new Set(expanded);
    for (const id of userExpanded) {
      if (expanded.has(id)) merged.delete(id);
      else merged.add(id);
    }
    return merged;
  }, [expanded, userExpanded, searchExpanded]);

  const pastePlacements = async (target: TreePlacement, mode: "inside" | "after") => {
    if (!treeClipboard) return;
    const parentPlacementId = mode === "inside" ? target.placementId : target.parentPlacementId;
    if (!parentPlacementId) return;
    const siblings = tree.filter(
      (item) => item.parentPlacementId === parentPlacementId && !item.isSystem && !item.isTrash,
    );
    const targetIndex = siblings.findIndex((item) => item.placementId === target.placementId);
    const position = mode === "inside" ? siblings.length : targetIndex + 1;
    if (position < 0) return;
    for (let index = 0; index < treeClipboard.placements.length; index += 1) {
      const source = treeClipboard.placements[index];
      if (treeClipboard.mode === "cut") await client.movePlacement(source.placementId, parentPlacementId, position + index);
      else {
        const clone = await client.clonePlacement(source.noteId, parentPlacementId);
        await client.movePlacement(clone.id, parentPlacementId, position + index);
      }
    }
    if (treeClipboard.mode === "cut") onSetClipboard(null);
    refreshTree();
  };

  return (
    <>
      <nav className="quickbar" aria-label={t(locale, "quickActions")}>
        <div className="quickbar-top">
          <button
            className="quickbar-brand"
            aria-label={t(locale, "quickHome")}
            title={t(locale, "quickHome")}
            onClick={onClearTabs}
          >
            <img src="/ygdria-forest-mark.png" alt="" aria-hidden="true" />
          </button>
          <QuickButton
            label={t(locale, "quickNewNote")}
            disabled={creatingNote}
            onClick={() => onCreateNote()}
          >
            <FilePlus2 />
          </QuickButton>
          <QuickButton label={t(locale, "quickTodayNote")} onClick={onOpenTodayNote}>
            <Calendar />
          </QuickButton>
          <QuickButton label={t(locale, "quickActionSearch")} active={activeTabId === "search"} onClick={() => {
            if (activeTabId === "search") onCloseSearch();
            else onOpenSearch();
          }}>
            <Search />
          </QuickButton>
        </div>
        <div className="quickbar-bottom">
          <QuickButton
            label={protectedSession.unlocked
              ? t(locale, "lockProtectedSession")
              : protectedSession.configured
                ? t(locale, "unlockProtectedSession")
                : t(locale, "setupProtectedSession")}
            active={protectedSession.unlocked}
            className="protected-session-shortcut"
            onClick={onProtectedSessionToggle}
          >
            {protectedSession.unlocked ? <Unlock /> : <Lock />}
          </QuickButton>
          <QuickButton
            label={t(locale, "quickHistory")}
            active={activeTabId === "history"}
            onClick={() => {
              if (activeTabId === "history") onCloseHistory();
              else onOpenHistory();
            }}
          >
            <History />
          </QuickButton>
          {window.ygdria && (
            <QuickButton
              label={`${syncing ? t(locale, "syncInProgress") : syncState === "pending" ? t(locale, "syncNeeded") : syncState === "synced" ? t(locale, "syncUpToDate") : t(locale, "syncServer")}${syncProgress ? ` · ${syncProgress}` : ""}`}
              className={`sync-shortcut sync-${syncing ? "syncing" : syncState}`}
              disabled={syncing}
              onClick={onSync}
            >
              {syncing ? <RefreshCw /> : syncState === "synced" ? <CloudCheck /> : syncState === "pending" ? <CloudUpload /> : <RefreshCw />}
            </QuickButton>
          )}
          <QuickButton
            label={t(locale, "quickSettings")}
            active={settingsOpen}
            onClick={() => {
              if (settingsOpen) onCloseSettings();
              else onOpenSettings();
            }}
          >
            <Settings />
          </QuickButton>
          <QuickButton label={t(locale, "archivedNotes")} active={activeTabId === "archive"} onClick={onOpenArchive}>
            <Archive />
          </QuickButton>
          <QuickButton
            label={t(locale, "attachments")}
            active={activeTabId === "attachments"}
            onClick={() => {
              if (activeTabId === "attachments") onCloseAttachments();
              else onOpenAttachments();
            }}
          >
            <Paperclip />
          </QuickButton>
          <QuickButton
            label={t(locale, collapsed ? "quickExpand" : "quickCollapse")}
            onClick={onToggleCollapse}
          >
            <ChevronsLeft />
          </QuickButton>
        </div>
      </nav>
      <aside id="note-tree-panel" className="note-tree-panel">
        <div className="mobile-tree-actions">
          <button
            type="button"
            aria-label={t(locale, "quickHome")}
            title={t(locale, "quickHome")}
            onClick={onClearTabs}
          >
            <Home size={20} />
          </button>
          <button
            type="button"
            disabled={creatingNote}
            aria-label={t(locale, "quickNewNote")}
            title={t(locale, "quickNewNote")}
            onClick={() => onCreateNote()}
          >
            <FilePlus2 size={20} />
          </button>
          <button
            type="button"
            aria-label={t(locale, "quickTodayNote")}
            title={t(locale, "quickTodayNote")}
            onClick={onOpenTodayNote}
          >
            <Calendar size={20} />
          </button>
          <button
            type="button"
            aria-label={protectedSession.unlocked
              ? t(locale, "lockProtectedSession")
              : protectedSession.configured
                ? t(locale, "unlockProtectedSession")
                : t(locale, "setupProtectedSession")}
            title={protectedSession.unlocked
              ? t(locale, "lockProtectedSession")
              : protectedSession.configured
                ? t(locale, "unlockProtectedSession")
                : t(locale, "setupProtectedSession")}
            className={protectedSession.unlocked ? "active" : ""}
            onClick={onProtectedSessionToggle}
          >
            {protectedSession.unlocked ? <Unlock size={20} /> : <Lock size={20} />}
          </button>
          {window.ygdria && (
            <button
              type="button"
              disabled={syncing}
              aria-label={`${syncing ? t(locale, "syncInProgress") : syncState === "pending" ? t(locale, "syncNeeded") : syncState === "synced" ? t(locale, "syncUpToDate") : t(locale, "syncServer")}${syncProgress ? ` · ${syncProgress}` : ""}`}
              title={`${syncing ? t(locale, "syncInProgress") : syncState === "pending" ? t(locale, "syncNeeded") : syncState === "synced" ? t(locale, "syncUpToDate") : t(locale, "syncServer")}${syncProgress ? ` · ${syncProgress}` : ""}`}
              className={`sync-shortcut sync-${syncing ? "syncing" : syncState}`}
              onClick={onSync}
            >
              {syncing ? <RefreshCw size={20} /> : syncState === "synced" ? <CloudCheck size={20} /> : syncState === "pending" ? <CloudUpload size={20} /> : <RefreshCw size={20} />}
            </button>
          )}
        </div>
        <div className="tree-search">
          <Search size={18} />
          <input
            ref={searchInputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(locale, "searchNotes")}
            aria-label={t(locale, "searchNotes")}
          />
        </div>
        <nav className="note-tree" aria-label="Note tree">
          <NoteTree
            placements={tree}
            expanded={effectiveExpanded}
            search={search}
            selectedNoteId={selected}
            selectedPlacementId={selectedPlacementId}
            selectedPlacementIds={selectedPlacementIds}
            locale={locale}
            matchesSearch={matchesSearch}
            decryptedTitles={decryptedTitles}
            onSelect={onSelectPlacement}
            onToggle={(placementId) => setUserExpanded((current) => {
              const next = new Set(current);
              next.has(placementId) ? next.delete(placementId) : next.add(placementId);
              return next;
            })}
            onCreateChild={(placementId) => onCreateNote(placementId)}
            creatingNote={creatingNote}
            onMove={(placementId, parentPlacementId, position) => {
              void client.movePlacement(placementId, parentPlacementId, position).then(refreshTree);
            }}
            onContextMenu={(placement, event) => {
              if (placement.isTrashed || placement.isTrash) return;
              event.preventDefault();
              onContextMenu(placement, event.clientX, event.clientY);
            }}
          />
        </nav>
      </aside>
      {!collapsed && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize note sidebar"
          aria-orientation="vertical"
          onPointerDown={onResizePanel}
        />
      )}
    </>
  );
}
