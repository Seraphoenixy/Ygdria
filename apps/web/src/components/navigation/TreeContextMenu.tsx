import React from "react";
import {
  FolderPlus, FileCode2, Archive, ArchiveRestore, X, Copy,
  Trash2, FileText, Lock, Unlock,
} from "lucide-react";
import { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";

type TreeContextMenuProps = {
  menu: { placement: TreePlacement; x: number; y: number };
  client: YgdriaClient;
  tree: TreePlacement[];
  selectedPlacementId?: string;
  selectedPlacementIds: Set<string>;
  treeClipboard: { placements: TreePlacement[]; mode: "cut" | "copy" } | null;
  locale: Locale;
  onClose: () => void;
  onCreateChild: (parentPlacementId: string, type?: "text" | "code") => void;
  onArchive: (noteId: string, archived: boolean) => void;
  onSetClipboard: (clipboard: { placements: TreePlacement[]; mode: "cut" | "copy" } | null) => void;
  onDelete: (placements: TreePlacement[]) => void;
  onPaste: (target: TreePlacement, mode: "inside" | "after") => void;
  onExport: (placements: TreePlacement[]) => void;
  onImport: (targetPlacementId: string) => void;
  onOpenInNewTab?: (placement: TreePlacement) => void;
  onProtectSubtree?: (placement: TreePlacement, protect: boolean) => void;
};

export function TreeContextMenu({
  menu, client, tree, selectedPlacementId, selectedPlacementIds,
  treeClipboard, locale, onClose, onCreateChild, onArchive,
  onSetClipboard, onDelete, onPaste,   onExport, onImport, onOpenInNewTab, onProtectSubtree,
}: TreeContextMenuProps) {
  const { placement } = menu;
  const contextSelection = (target: TreePlacement) => {
    const selected = tree.filter((item) => selectedPlacementIds.has(item.placementId));
    return selectedPlacementIds.has(target.placementId) && selected.length ? selected : [target];
  };
  const items = contextSelection(placement);
  const modifier = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";

  return (
    <div
      className="action-menu tree-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        role="menuitem"
        onClick={() => { onCreateChild(placement.placementId); onClose(); }}
      >
        <FolderPlus size={16} /> {t(locale, "newChildNote")}
      </button>
      <button
        role="menuitem"
        disabled={placement.isSystem}
        onClick={() => { onCreateChild(placement.placementId, "code"); onClose(); }}
      >
        <FileCode2 size={16} /> {t(locale, "newChildCodeNote")}
      </button>
      {onOpenInNewTab && (
        <button
          role="menuitem"
          onClick={() => { onOpenInNewTab(placement); onClose(); }}
        >
          <FileText size={16} /> {t(locale, "openInNewTab")}
        </button>
      )}
      <button
        role="menuitem"
        disabled={placement.isSystem || placement.isProtected}
        onClick={() => {
          for (const item of items) onArchive(item.noteId, !placement.isArchived);
          onClose();
        }}
      >
        {placement.isArchived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        {t(locale, placement.isArchived ? "unarchive" : "archive")}
      </button>
      {onProtectSubtree && !placement.isSystem && (
        <button
          role="menuitem"
          onClick={() => { onProtectSubtree(placement, !placement.isProtected); onClose(); }}
        >
          {placement.isProtected ? <Unlock size={16} /> : <Lock size={16} />}
          {t(locale, placement.isProtected ? "unprotectSubtree" : "protectSubtree")}
        </button>
      )}
      <button className="with-shortcut" role="menuitem" disabled={placement.isSystem} onClick={() => { onSetClipboard({ placements: items, mode: "cut" }); onClose(); }}>
        <X size={16} /> <span>{t(locale, "cut")}</span><kbd>{modifier}+X</kbd>
      </button>
      <button className="with-shortcut" role="menuitem" onClick={() => { onSetClipboard({ placements: items, mode: "copy" }); onClose(); }}>
        <Copy size={16} /> <span>{t(locale, "copyNotes")}</span><kbd>{modifier}+C</kbd>
      </button>
      <button className="with-shortcut" role="menuitem" disabled={!treeClipboard} onClick={() => { onPaste(placement, "inside"); onClose(); }}>
        <span>{t(locale, "pasteInside")}</span><kbd>{modifier}+V</kbd>
      </button>
      <button role="menuitem" disabled={!treeClipboard} onClick={() => { onPaste(placement, "after"); onClose(); }}>
        {t(locale, "pasteAfter")}
      </button>
      <div className="context-separator" />
      <button role="menuitem" onClick={() => { onExport(items); onClose(); }}>{t(locale, "exportNotes")}</button>
      <button role="menuitem" onClick={() => { onImport(placement.placementId); onClose(); }}>{t(locale, "importNotes")}</button>
      <div className="context-separator" />
      <button
        className="danger with-shortcut"
        role="menuitem"
        disabled={placement.isSystem}
        onClick={() => {
          onDelete(items);
          onClose();
        }}
      >
        <Trash2 size={16} /> <span>{t(locale, "deleteNote")}</span><kbd>Delete</kbd>
      </button>
    </div>
  );
}
