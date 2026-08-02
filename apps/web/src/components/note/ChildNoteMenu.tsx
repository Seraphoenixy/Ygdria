import React from "react";
import { ExternalLink, Columns2, AppWindow, Pencil } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement, WorkspaceTab } from "../../types/workspace";

type ChildNoteMenuProps = {
  menu: { placement: TreePlacement; x: number; y: number };
  locale: Locale;
  onClose: () => void;
  onOpenInNewTab: (placement: TreePlacement) => void;
  onQuickEdit: (placement: TreePlacement) => void;
  onOpenInNewWindow: (tab: WorkspaceTab) => void;
};

export function ChildNoteMenu({
  menu, locale, onClose, onOpenInNewTab, onQuickEdit, onOpenInNewWindow,
}: ChildNoteMenuProps) {
  const { placement } = menu;
  return (
    <div
      className="action-menu tree-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={() => { onOpenInNewTab(placement); onClose(); }}>
        <ExternalLink size={17} /> {t(locale, "openInNewTab")}
      </button>
      <button role="menuitem" onClick={() => { onOpenInNewTab(placement); onClose(); }}>
        <Columns2 size={17} /> {t(locale, "openInSplitView")}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          const tab: WorkspaceTab = { id: `note:${placement.noteId}:${placement.isTrashed ? "trash" : "active"}`, kind: "note", noteId: placement.noteId, isTrashed: Boolean(placement.isTrashed) };
          onOpenInNewWindow(tab);
          onClose();
        }}
      >
        <AppWindow size={17} /> {t(locale, "openInNewWindow")}
      </button>
      <button role="menuitem" onClick={() => { onQuickEdit(placement); onClose(); }}>
        <Pencil size={17} /> {t(locale, "quickEdit")}
      </button>
    </div>
  );
}
