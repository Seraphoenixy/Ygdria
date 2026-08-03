import { ChevronRight, Code2, Copy, FileText, Folder, Lock, Plus } from "lucide-react";
import { useState, type DragEvent } from "react";
import type React from "react";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";

export function NoteTree({
  placements, expanded, search, selectedNoteId, selectedPlacementId, selectedPlacementIds, locale, matchesSearch,
  decryptedTitles,
  onSelect, onToggle, onCreateChild, onContextMenu, onMove, creatingNote,
}: {
  placements: TreePlacement[];
  expanded: Set<string>;
  search: string;
  selectedNoteId?: string;
  selectedPlacementId?: string;
  selectedPlacementIds: Set<string>;
  locale: Locale;
  matchesSearch: (placement: TreePlacement) => boolean;
  /** Decrypted titles for protected notes (noteId -> title). Empty when locked. */
  decryptedTitles: Map<string, string>;
  onSelect: (placement: TreePlacement, event: React.MouseEvent<HTMLElement>) => void;
  onToggle: (placementId: string) => void;
  onCreateChild: (placementId: string) => void;
  onContextMenu: (placement: TreePlacement, event: React.MouseEvent<HTMLElement>) => void;
  onMove: (placementIds: string[], parentPlacementId: string, position: number) => void;
  creatingNote: boolean;
}) {
  type DropMode = "before" | "inside" | "after";
  const [draggingIds, setDraggingIds] = useState<string[]>();
  const [dropTarget, setDropTarget] = useState<{ placementId: string; mode: DropMode }>();
  const childrenByParent = new Map<string | null, TreePlacement[]>();
  for (const placement of placements) {
    const key = placement.parentPlacementId;
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), placement]);
  }
  const placementCountByNoteId = new Map<string, number>();
  for (const placement of placements) {
    placementCountByNoteId.set(placement.noteId, (placementCountByNoteId.get(placement.noteId) ?? 0) + 1);
  }
  const canMoveTo = (sourceId: string, parentPlacementId: string | null) => {
    let currentId = parentPlacementId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      if (currentId === sourceId) return false;
      seen.add(currentId);
      currentId = placements.find((placement) => placement.placementId === currentId)?.parentPlacementId ?? null;
    }
    return true;
  };
  const dropModeFor = (event: DragEvent<HTMLDivElement>, target: TreePlacement, sourceIds: string[]): DropMode => {
    const { top, height } = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - top) / height;
    const rawMode = offset < 0.25 ? "before" : offset > 0.75 ? "after" : "inside";
    // When reordering siblings, the middle of a row should still mean a
    // sibling insertion. Otherwise a natural drop over the earlier sibling
    // becomes an unintended nested move instead of moving up the list.
    const sameParent = sourceIds.length > 0 && sourceIds.every(
      (sourceId) => placements.find((placement) => placement.placementId === sourceId)?.parentPlacementId === target.parentPlacementId,
    );
    if (rawMode === "inside" && sameParent) return offset < 0.5 ? "before" : "after";
    return rawMode;
  };
  const destinationFor = (target: TreePlacement, mode: DropMode, sourceIds: string[]) => {
    const parentPlacementId = mode === "inside" ? target.placementId : target.parentPlacementId;
    if (!parentPlacementId || sourceIds.some((sourceId) => !canMoveTo(sourceId, parentPlacementId))) return;
    const siblings = (childrenByParent.get(parentPlacementId) ?? [])
      .filter((placement) => !sourceIds.includes(placement.placementId) && !placement.isSystem && !placement.isTrash);
    const targetIndex = siblings.findIndex((placement) => placement.placementId === target.placementId);
    const position = mode === "inside" ? siblings.length : targetIndex + (mode === "after" ? 1 : 0);
    if (position < 0) return;
    return { parentPlacementId, position };
  };
  const renderTree = (parentPlacementId: string | null, depth = 0): React.ReactNode =>
    (childrenByParent.get(parentPlacementId) ?? []).filter((placement) => !placement.isTrash).filter(matchesSearch).map((placement) => {
      const children = childrenByParent.get(placement.placementId) ?? [];
      const hasChildren = children.length > 0;
      const isExpanded = expanded.has(placement.placementId);
      const title = placement.isSystem && placement.parentPlacementId === null
        ? t(locale, "rootNode")
        : placement.isProtected
          ? (decryptedTitles.get(placement.noteId) ?? `[${t(locale, "protectedNote")}]`)
          : placement.title;
      const isDraggable = !placement.isSystem && !placement.isTrashed && !placement.isTrash;
      const isDropTarget = dropTarget?.placementId === placement.placementId;
      const isCloned = (placementCountByNoteId.get(placement.noteId) ?? 0) > 1;
      const isRelatedClone = Boolean(selectedPlacementId) && placement.noteId === selectedNoteId && placement.placementId !== selectedPlacementId;
      return <div
        className={`tree-branch ${hasChildren ? "has-children" : ""}`}
        key={placement.placementId}
        // The guide continues straight down from this branch's disclosure arrow.
        style={{ "--tree-guide-left": `${2 + depth * 10}px` } as React.CSSProperties}
      >
        <div
          className={`tree-item ${placement.placementId === selectedPlacementId ? "active" : ""} ${selectedPlacementIds.has(placement.placementId) ? "multi-selected" : ""} ${placement.isTrashed ? "trashed" : ""} ${placement.isArchived ? "archived" : ""} ${draggingIds?.includes(placement.placementId) ? "dragging" : ""} ${isDropTarget ? `drop-${dropTarget.mode}` : ""}`}
          style={{ marginLeft: -13 + depth * 10 }}
          draggable={isDraggable}
          onDragStart={(event) => {
            const sourceIds = selectedPlacementIds.has(placement.placementId)
              ? placements
                .filter((item) => selectedPlacementIds.has(item.placementId) && !item.isSystem && !item.isTrash && !item.isTrashed)
                .sort((a, b) => a.position - b.position || a.placementId.localeCompare(b.placementId))
                .map((item) => item.placementId)
              : [placement.placementId];
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", JSON.stringify(sourceIds));
            setDraggingIds(sourceIds);
          }}
          onDragEnd={() => { setDraggingIds(undefined); setDropTarget(undefined); }}
          onDragOver={(event) => {
            const sourceIds = draggingIds ?? (() => {
              try { return JSON.parse(event.dataTransfer.getData("text/plain")) as string[]; } catch { return []; }
            })();
            const mode = dropModeFor(event, placement, sourceIds);
            const parentId = mode === "inside" ? placement.placementId : placement.parentPlacementId;
            if (!sourceIds.length || !parentId || sourceIds.some((sourceId) => !canMoveTo(sourceId, parentId)) || (placement.isTrash || (placement.isSystem && mode !== "inside"))) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget({ placementId: placement.placementId, mode });
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(undefined);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const sourceIds = draggingIds ?? (() => {
              try { return JSON.parse(event.dataTransfer.getData("text/plain")) as string[]; } catch { return []; }
            })();
            const mode = dropModeFor(event, placement, sourceIds);
            const destination = sourceIds.length ? destinationFor(placement, mode, sourceIds) : undefined;
            if (sourceIds.length && destination) onMove(sourceIds, destination.parentPlacementId, destination.position);
            setDraggingIds(undefined);
            setDropTarget(undefined);
          }}
          onContextMenu={(event) => onContextMenu(placement, event)}
        >
          <button className="tree-select-hit" type="button" aria-label={title} onClick={(event) => onSelect(placement, event)} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onSelect(placement, event); } }} />
          {hasChildren ? <button className={`tree-toggle visible ${isExpanded ? "expanded" : ""}`} aria-label={t(locale, isExpanded ? "collapseNote" : "expandNote")} onClick={(event) => { event.stopPropagation(); onToggle(placement.placementId); }}><ChevronRight size={17} /></button> : <span className="tree-toggle" aria-hidden="true" />}
          {hasChildren || placement.isCalendar ? <Folder className="tree-icon" size={16} /> : placement.type === "code" ? <Code2 className="tree-icon" size={16} /> : <FileText className="tree-icon" size={16} />}
          {Boolean(placement.isProtected) && <Lock className="tree-lock-icon" size={14} aria-label={t(locale, "protectedNote")} />}
          <span className={`tree-label ${isRelatedClone ? "clone-related" : ""}`}>{title}</span>
          {isCloned && <Copy className="tree-clone-mark" size={14} aria-label={t(locale, "cloneMarker")} />}
          {!placement.isTrashed && <button className="tree-add" disabled={creatingNote} aria-label={t(locale, "createChild", { title: placement.title })} onClick={(event) => { event.stopPropagation(); onCreateChild(placement.placementId); }}><Plus size={16} /></button>}
        </div>
        {hasChildren && (isExpanded || Boolean(search.trim())) && renderTree(placement.placementId, depth + 1)}
      </div>;
    });
  const hasMatches = search.trim()
    ? placements.some((placement) => !placement.isTrash && matchesSearch(placement))
    : true;
  return (
    <>
      {renderTree(null)}
      {search.trim() && !hasMatches && <p className="tree-no-match">{t(locale, "noMatchingNotes")}</p>}
    </>
  );
}
