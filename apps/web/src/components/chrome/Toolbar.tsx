import React, { useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, Ellipsis, FileCode2, FileText, History, Home, Menu, RotateCcw } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";

type BreadcrumbSegment =
  | { type: "root"; placementId: string; noteId: string; title: string }
  | { type: "page"; title: string }
  | { type: "note"; placementId: string; noteId: string; title: string };

type ToolbarProps = {
  breadcrumb: BreadcrumbSegment[];
  isTrashed: boolean;
  hasNote: boolean;
  locale: Locale;
  onNavigateHome: () => void;
  onNavigateNote: (noteId: string) => void;
  onRestore: () => void;
  isRestoring?: boolean;
  showInspector?: boolean;
  inspectorCollapsed?: boolean;
  onToggleInspector?: () => void;
  onToggleTree?: () => void;
  noteType?: "text" | "code" | "file";
  canConvertNote?: boolean;
  onConvertNote?: () => void;
  canViewRevisionHistory?: boolean;
  onViewRevisionHistory?: () => void;
  onToggleMarkdownView?: () => void;
  markdownView?: boolean;
};

export function Toolbar({
  breadcrumb, isTrashed, hasNote, locale,
  onNavigateHome, onNavigateNote, onRestore, isRestoring,
  showInspector, inspectorCollapsed, onToggleInspector, onToggleTree,
  noteType, canConvertNote, onConvertNote, canViewRevisionHistory, onViewRevisionHistory,
  onToggleMarkdownView, markdownView,
}: ToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const convertLabel = t(locale, noteType === "code" ? "convertToTextNote" : "convertToCodeNote");

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen]);

  return (
    <header className="note-toolbar">
      {onToggleTree && (
        <button
          type="button"
          className="toolbar-icon mobile-tree-toggle"
          title={t(locale, "openNoteTree")}
          aria-label={t(locale, "openNoteTree")}
          onClick={onToggleTree}
        >
          <Menu size={18} />
        </button>
      )}
      <div className="crumb">
        {breadcrumb.map((segment, index) => {
          const isLast = index === breadcrumb.length - 1;
          return (
            <React.Fragment key={segment.type === "page" ? `page-${index}` : segment.placementId}>
              {index > 0 && <span className="crumb-separator">&gt;</span>}
              {segment.type === "root" ? (
                <button className="crumb-link crumb-root" onClick={onNavigateHome} title={segment.title}>
                  <Home size={14} />
                </button>
              ) : segment.type === "page" || isLast ? (
                <span className="crumb-current">{segment.title}</span>
              ) : (
                <button
                  className="crumb-link"
                  onClick={() => onNavigateNote(segment.noteId)}
                  title={segment.title}
                >
                  {segment.title}
                </button>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="toolbar-actions">
        {onToggleMarkdownView && (
          <button
            type="button"
            className="toolbar-icon toolbar-markdown-toggle"
            title={t(locale, markdownView ? "richTextView" : "markdownView")}
            aria-label={t(locale, markdownView ? "richTextView" : "markdownView")}
            aria-pressed={markdownView}
            onClick={onToggleMarkdownView}
          >
            <FileCode2 size={18} />
          </button>
        )}
        {hasNote && isTrashed && (
          <button onClick={onRestore} disabled={isRestoring}>
            <RotateCcw size={17} /> {t(locale, "restoreNote")}
          </button>
        )}
        {((canConvertNote && onConvertNote) || (canViewRevisionHistory && onViewRevisionHistory)) && (
          <div ref={moreMenuRef} className="toolbar-more">
            <button
              type="button"
              className="toolbar-icon toolbar-more-trigger"
              title={t(locale, "moreActions")}
              aria-label={t(locale, "moreActions")}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <Ellipsis size={18} />
            </button>
            {moreOpen && (
              <div className="action-menu toolbar-more-menu" role="menu">
                {canViewRevisionHistory && onViewRevisionHistory && <button role="menuitem" onClick={() => { onViewRevisionHistory(); setMoreOpen(false); }}><History size={16} /> <span>{t(locale, "viewRevisionHistory")}</span></button>}
                {canConvertNote && onConvertNote && <button role="menuitem" onClick={() => { onConvertNote(); setMoreOpen(false); }}>
                  {noteType === "code" ? <FileText size={16} /> : <FileCode2 size={16} />} <span>{convertLabel}</span>
                </button>}
              </div>
            )}
          </div>
        )}
        {showInspector && onToggleInspector && (
          <button
            type="button"
            className="toolbar-icon inspector-toolbar-toggle"
            title={inspectorCollapsed ? "展开右侧栏" : "收起右侧栏"}
            aria-label={inspectorCollapsed ? "展开右侧栏" : "收起右侧栏"}
            onClick={onToggleInspector}
          >
            {inspectorCollapsed ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}
          </button>
        )}
      </div>
    </header>
  );
}

export type { BreadcrumbSegment };
