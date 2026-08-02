import React, { useCallback, useEffect, useMemo } from "react";
import type { YgdriaClient } from "@ygdria/api-client";
import { SYSTEM_ROOT_NOTE_ID } from "@ygdria/shared";
import type { Locale } from "../lib/i18n";
import { t } from "../lib/i18n";
import type { TreePlacement, WorkspaceTab } from "../types/workspace";

type UseWorkspaceSelectionOptions = {
  client: YgdriaClient;
  locale: Locale;
  treeData: TreePlacement[] | undefined;
  selected?: string;
  selectedPlacementId?: string;
  selectedPlacementIds: Set<string>;
  selectionParentId: string | null | undefined;
  selectionAnchorId: string | undefined;
  activeTabId?: string;
  activeTab?: WorkspaceTab;
  settingsOpen: boolean;
  decryptedTitles: Map<string, string>;
  treeClipboard: { placements: TreePlacement[]; mode: "cut" | "copy" } | null;
  setTreeClipboard: (clipboard: { placements: TreePlacement[]; mode: "cut" | "copy" } | null) => void;
  setSelectedPlacementIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSelectedPlacementId: (id: string | undefined) => void;
  setSelectionParentId: (id: string | null | undefined) => void;
  setSelectionAnchorId: (id: string | undefined) => void;
  setDeleteConfirmation: (placements: TreePlacement[] | null) => void;
  refreshTree: () => void;
  openNote: (noteId: string, isTrashed?: boolean, editing?: boolean, openInNewTab?: boolean, placementId?: string) => void;
  tabs: WorkspaceTab[];
  noteData?: { id: string; title: string; isProtected?: boolean } | null;
};

export function useWorkspaceSelection({
  client,
  locale,
  treeData,
  selected,
  selectedPlacementId,
  selectedPlacementIds,
  selectionParentId,
  selectionAnchorId,
  activeTabId,
  activeTab,
  settingsOpen,
  decryptedTitles,
  treeClipboard,
  setTreeClipboard,
  setSelectedPlacementIds,
  setSelectedPlacementId,
  setSelectionParentId,
  setSelectionAnchorId,
  setDeleteConfirmation,
  refreshTree,
  openNote,
  tabs,
  noteData,
}: UseWorkspaceSelectionOptions) {
  const childrenByParent = useMemo(() => {
    const byParent = new Map<string | null, TreePlacement[]>();
    for (const placement of treeData ?? []) {
      const key = placement.parentPlacementId ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), placement]);
    }
    return byParent;
  }, [treeData]);

  const currentPlacement = useMemo(() => {
    const placements = treeData ?? [];
    return (
      placements.find(
        (item) => item.placementId === selectedPlacementId && item.noteId === selected,
      ) ?? placements.find((item) => item.noteId === selected && !item.isTrashed && !item.isTrash)
    );
  }, [treeData, selected, selectedPlacementId]);

  // Tabs identify notes, while the tree selection identifies placements.
  // Synchronize the active tab to its placement so the tree shows the active
  // selection even after switching between already-open notes.
  useEffect(() => {
    if (activeTab?.kind !== "note") return;
    const placements = treeData ?? [];
    const placement =
      placements.find(
        (item) =>
          item.placementId === activeTab.placementId &&
          item.noteId === activeTab.noteId,
      ) ??
      placements.find(
        (item) =>
          item.noteId === activeTab.noteId &&
          item.isTrashed === activeTab.isTrashed &&
          !item.isTrash,
      );
    if (!placement) return;

    setSelectedPlacementIds(new Set());
    setSelectedPlacementId(placement.placementId);
    setSelectionParentId(placement.parentPlacementId);
    setSelectionAnchorId(placement.placementId);
  }, [activeTab, treeData, setSelectedPlacementIds, setSelectedPlacementId, setSelectionParentId, setSelectionAnchorId]);

  const noteBreadCrumb = useMemo(() => {
    if (!treeData) return [];
    const root = treeData.find((p) => p.parentPlacementId === null);
    const byId = new Map(treeData.map((p: TreePlacement) => [p.placementId, p]));
    const base = root
      ? [
          {
            type: "root" as const,
            placementId: root.placementId,
            noteId: root.noteId,
            title: root.title,
          },
        ]
      : [];
    if (activeTabId === "history")
      return [...base, { type: "page" as const, title: t(locale, "recentChanges") }];
    if (activeTabId === "search")
      return [...base, { type: "page" as const, title: t(locale, "searchTitle") }];
    if (activeTabId === "archive")
      return [...base, { type: "page" as const, title: t(locale, "archivedNotes") }];
    if (activeTabId === "attachments")
      return [...base, { type: "page" as const, title: t(locale, "attachments") }];
    if (activeTab?.kind === "new")
      return [...base, { type: "page" as const, title: t(locale, "newTab") }];
    if (settingsOpen)
      return [...base, { type: "page" as const, title: t(locale, "settingsTitle") }];
    if (!currentPlacement) return base;
    const chain: Array<{ type: "note"; placementId: string; noteId: string; title: string }> = [];
    let cur: TreePlacement | undefined = currentPlacement;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.placementId)) {
      seen.add(cur.placementId);
      const title = cur.isProtected
        ? (decryptedTitles.get(cur.noteId) ?? `[${t(locale, "protectedNote")}]`)
        : cur.title;
      chain.unshift({ type: "note", placementId: cur.placementId, noteId: cur.noteId, title });
      if (!cur.parentPlacementId) break;
      cur = byId.get(cur.parentPlacementId);
    }
    if (chain.length > 0 && chain[0].placementId === root?.placementId) {
      chain.shift();
    }
    return [...base, ...chain];
  }, [currentPlacement, treeData, activeTabId, activeTab, settingsOpen, locale, decryptedTitles]);

  const childNotes = useMemo(
    () =>
      currentPlacement
        ? ((childrenByParent.get(currentPlacement.placementId) ?? [])
            .filter((item) => !item.isSystem && !item.isTrash && !item.isTrashed)
            .sort((a, b) => a.position - b.position) as TreePlacement[])
        : [],
    [childrenByParent, currentPlacement],
  );

  const openChildNote = (placement: TreePlacement, nextEditing = false, openInNewTab = false) => {
    setSelectedPlacementIds(new Set());
    setSelectedPlacementId(placement.placementId);
    setSelectionParentId(placement.parentPlacementId);
    setSelectionAnchorId(placement.placementId);
    openNote(placement.noteId, Boolean(placement.isTrashed), nextEditing, openInNewTab, placement.placementId);
  };

  const selectTreePlacement = (placement: TreePlacement, event: React.MouseEvent<HTMLElement>) => {
    const isRangeSelect = event.shiftKey;
    const isToggleSelect = event.ctrlKey || event.metaKey;
    // A middle-click (button 1) opens the note in a new tab even without a
    // modifier; Ctrl/Cmd would normally select, so it can't be reused here.
    const openInNewTab = event.button === 1 || (event.ctrlKey || event.metaKey);
    if (!isRangeSelect && !isToggleSelect) {
      setSelectedPlacementIds(new Set());
      setSelectedPlacementId(placement.placementId);
      setSelectionParentId(placement.parentPlacementId);
      setSelectionAnchorId(placement.placementId);
      openNote(
        placement.noteId,
        Boolean(placement.isTrashed),
        false,
        openInNewTab,
        placement.placementId,
      );
      return;
    }
    event.preventDefault();
    const parentId = placement.parentPlacementId;
    const siblings = (childrenByParent.get(parentId) ?? []).filter(
      (item) => !item.isSystem && !item.isTrashed,
    ) as TreePlacement[];
    if (isRangeSelect && selectionParentId === parentId && selectionAnchorId) {
      const start = siblings.findIndex((item) => item.placementId === selectionAnchorId);
      const end = siblings.findIndex((item) => item.placementId === placement.placementId);
      if (start >= 0 && end >= 0) {
        setSelectedPlacementIds(
          new Set(
            siblings
              .slice(Math.min(start, end), Math.max(start, end) + 1)
              .map((item) => item.placementId),
          ),
        );
        return;
      }
    }
    if (isToggleSelect && selectionParentId === parentId) {
      setSelectedPlacementIds((current) => {
        const next = new Set(current);
        next.has(placement.placementId)
          ? next.delete(placement.placementId)
          : next.add(placement.placementId);
        return next;
      });
    } else {
      setSelectedPlacementIds(new Set([placement.placementId]));
      setSelectionParentId(parentId);
    }
    setSelectionAnchorId(placement.placementId);
  };

  const pastePlacements = useCallback(
    async (target: TreePlacement, mode: "inside" | "after") => {
      if (!treeClipboard) return;
      const parentPlacementId = mode === "inside" ? target.placementId : target.parentPlacementId;
      if (!parentPlacementId) return;
      const siblings = (treeData ?? []).filter(
        (item) => item.parentPlacementId === parentPlacementId && !item.isSystem && !item.isTrash,
      );
      const targetIndex = siblings.findIndex((item) => item.placementId === target.placementId);
      const position = mode === "inside" ? siblings.length : targetIndex + 1;
      if (position < 0) return;
      for (let index = 0; index < treeClipboard.placements.length; index += 1) {
        const source = treeClipboard.placements[index];
        if (treeClipboard.mode === "cut")
          await client.movePlacement(source.placementId, parentPlacementId, position + index);
        else {
          const clone = await client.clonePlacement(source.noteId, parentPlacementId);
          await client.movePlacement(clone.id, parentPlacementId, position + index);
        }
      }
      if (treeClipboard.mode === "cut") setTreeClipboard(null);
      refreshTree();
    },
    [client, refreshTree, treeData, treeClipboard, setTreeClipboard],
  );

  // Tree clipboard shortcuts
  useEffect(() => {
    const onTreeClipboardShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isDelete = event.key === "Delete";
      if ((!event.ctrlKey && !event.metaKey && !isDelete) || event.altKey) return;
      if (key !== "x" && key !== "c" && key !== "v" && !isDelete) return;

      const focused = document.activeElement as Element | null;
      if (!focused?.closest(".note-tree-panel")) return;
      if (
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        (focused as HTMLElement).isContentEditable
      )
        return;

      const selectedItems = (treeData ?? [])
        .filter(
          (item) =>
            selectedPlacementIds.has(item.placementId) ||
            (selectedPlacementIds.size === 0 && item.placementId === selectedPlacementId),
        )
        .filter((item) => !item.isSystem && !item.isTrashed && !item.isTrash);

      if (isDelete) {
        if (!selectedItems.length) return;
        event.preventDefault();
        setDeleteConfirmation(selectedItems);
        return;
      }

      if (key === "x" || key === "c") {
        if (!selectedItems.length) return;
        event.preventDefault();
        setTreeClipboard({ placements: selectedItems, mode: key === "x" ? "cut" : "copy" });
        return;
      }

      const target = (treeData ?? []).find((item) => item.placementId === selectedPlacementId);
      if (!treeClipboard || !target || target.isSystem || target.isTrashed || target.isTrash)
        return;
      if (
        treeClipboard.mode === "cut" &&
        treeClipboard.placements.some((item) => item.placementId === target.placementId)
      )
        return;
      event.preventDefault();
      void pastePlacements(target, "inside").catch((error) =>
        console.error("Unable to paste notes", error),
      );
    };
    window.addEventListener("keydown", onTreeClipboardShortcut);
    return () => window.removeEventListener("keydown", onTreeClipboardShortcut);
  }, [
    pastePlacements,
    selectedPlacementId,
    selectedPlacementIds,
    treeData,
    treeClipboard,
    setDeleteConfirmation,
    setTreeClipboard,
  ]);

  const treeTitleForTab = (tab: WorkspaceTab) => {
    if (tab.kind !== "note") return undefined;
    const placement = treeData?.find((item) => item.noteId === tab.noteId);
    if (!placement) return undefined;
    return placement.isProtected
      ? (decryptedTitles.get(placement.noteId) ?? `[${t(locale, "protectedNote")}]`)
      : placement.title;
  };

  const noteTitleForTab = (tab: WorkspaceTab) => {
    if (tab.kind !== "note") return undefined;
    if (tab.id === activeTabId && noteData?.id === tab.noteId && !noteData.isProtected)
      return noteData.title;
    return treeTitleForTab(tab);
  };

  return {
    childrenByParent,
    currentPlacement,
    noteBreadCrumb,
    childNotes,
    openChildNote,
    selectTreePlacement,
    pastePlacements,
    treeTitleForTab,
    noteTitleForTab,
  };
}
