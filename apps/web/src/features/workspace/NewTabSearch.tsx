import { ChevronRight, Code2, FileText, Folder, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";

type NewTabSearchProps = {
  treeData: TreePlacement[] | undefined;
  locale: Locale;
  decryptedTitles: Map<string, string>;
  openNote: (noteId: string, isTrashed?: boolean, editing?: boolean, openInNewTab?: boolean, placementId?: string) => void;
  createNewNote: () => Promise<void>;
  creatingNote: boolean;
};

type Row = { placement: TreePlacement; depth: number; path: string[] };

/**
 * A note-tree-like quick finder shown on a fresh "New tab".
 *
 * When no query is entered it behaves as a read-only browse of the whole tree
 * (roots expanded). As soon as the user types, it filters by title and keeps
 * the ancestor branches visible so a match is always shown in its tree context,
 * exactly like the in-tree search box — but on a dedicated full-page surface.
 */
export function NewTabSearch({ treeData, locale, decryptedTitles, openNote, createNewNote, creatingNote }: NewTabSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const didInit = useRef(false);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [userExpanded, setUserExpanded] = useState<Set<string>>(() => new Set());

  const placements = useMemo(() => treeData ?? [], [treeData]);

  const byId = useMemo(() => new Map(placements.map((item) => [item.placementId, item])), [placements]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, TreePlacement[]>();
    for (const item of placements) {
      const key = item.parentPlacementId ?? null;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    for (const [key, list] of map) {
      map.set(key, [...list].sort((a, b) => a.position - b.position));
    }
    return map;
  }, [placements]);

  const rootIds = useMemo(
    () =>
      new Set(
        placements
          .filter((item) => item.parentPlacementId === null || item.isSystem || item.isCalendar)
          .map((item) => item.placementId),
      ),
    [placements],
  );

  const resolveTitle = (placement: TreePlacement): string => {
    if (placement.isSystem && placement.parentPlacementId === null) return t(locale, "rootNode");
    if (placement.isProtected) return decryptedTitles.get(placement.noteId) ?? `[${t(locale, "protectedNote")}]`;
    return placement.title;
  };

  // Build the visible rows + effective expansion in one pass so closures stay fresh.
  const { rows, expanded, isSearching, term } = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const searching = normalized.length > 0;

    const matchesSearch = (placement: TreePlacement): boolean => {
      if (!searching) return true;
      if (resolveTitle(placement).toLocaleLowerCase().includes(normalized)) return true;
      return (childrenByParent.get(placement.placementId) ?? []).some(matchesSearch);
    };

    const searchExpanded = new Set<string>();
    if (searching) {
      for (const placement of placements) {
        if (!matchesSearch(placement)) continue;
        searchExpanded.add(placement.placementId);
        let parentId = placement.parentPlacementId;
        while (parentId) {
          searchExpanded.add(parentId);
          parentId = byId.get(parentId)?.parentPlacementId ?? null;
        }
      }
    }

    const effectiveExpanded = searching ? searchExpanded : userExpanded;

    const buildPath = (placement: TreePlacement): string[] => {
      const path: string[] = [];
      const seen = new Set<string>();
      let currentId = placement.parentPlacementId;
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const parent = byId.get(currentId);
        if (!parent) break;
        path.unshift(resolveTitle(parent));
        currentId = parent.parentPlacementId;
      }
      return path;
    };

    const visible: Row[] = [];
    const walk = (parentPlacementId: string | null, depth: number) => {
      for (const placement of childrenByParent.get(parentPlacementId) ?? []) {
        if (placement.isTrash) continue;
        if (!matchesSearch(placement)) continue;
        visible.push({ placement, depth, path: buildPath(placement) });
        const hasChildren = (childrenByParent.get(placement.placementId) ?? []).length > 0;
        if (hasChildren && effectiveExpanded.has(placement.placementId)) {
          walk(placement.placementId, depth + 1);
        }
      }
    };
    walk(null, 0);

    return { rows: visible, expanded: effectiveExpanded, isSearching: searching, term: normalized };
  }, [query, placements, byId, childrenByParent, decryptedTitles, locale, userExpanded]);

  // Expand roots once the tree is first available.
  useEffect(() => {
    if (didInit.current || rootIds.size === 0) return;
    setUserExpanded(new Set(rootIds));
    didInit.current = true;
  }, [rootIds]);

  // Focus the input as soon as the page opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset keyboard selection whenever the result set changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, placements]);

  // Keep the active row visible.
  useEffect(() => {
    rowRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const openRow = (row: Row, event?: MouseEvent<HTMLElement>) => {
    const openInNewTab = Boolean(event && (event.ctrlKey || event.metaKey));
    openNote(row.placement.noteId, Boolean(row.placement.isTrashed), false, openInNewTab, row.placement.placementId);
  };

  const toggleExpand = (placementId: string) => {
    setUserExpanded((current) => {
      const next = new Set(current);
      if (next.has(placementId)) next.delete(placementId);
      else next.add(placementId);
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(rows.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[selectedIndex];
      if (row) openRow(row);
    } else if (event.key === "Escape") {
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  const highlight = (title: string): ReactNode => {
    if (!isSearching || !term) return title;
    const index = title.toLocaleLowerCase().indexOf(term);
    if (index < 0) return title;
    return (
      <>
        {title.slice(0, index)}
        <mark>{title.slice(index, index + term.length)}</mark>
        {title.slice(index + term.length)}
      </>
    );
  };

  const showEmpty = rows.length === 0;
  const emptyMessage = isSearching
    ? t(locale, "searchNoResults")
    : placements.length === 0
      ? t(locale, "newTabNoNotes")
      : t(locale, "searchNoResults");

  return (
    <div className="new-tab-search">
      <div className="nts-header">
        <div className="nts-input">
          <Search size={20} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(locale, "newTabSearchPlaceholder")}
            aria-label={t(locale, "searchNotes")}
          />
          {query && (
            <button className="nts-clear" type="button" aria-label="Clear" onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}>
              <X size={16} />
            </button>
          )}
        </div>
        <p className="nts-hint">{t(locale, "newTabSearchHint")}</p>
      </div>

      {showEmpty ? (
        <div className="nts-empty">{emptyMessage}</div>
      ) : (
        <div className="nts-tree" role="listbox" aria-label={t(locale, "noteTree")}>
          {rows.map((row, index) => {
            const placement = row.placement;
            const children = childrenByParent.get(placement.placementId) ?? [];
            const hasChildren = children.length > 0;
            const isExpanded = isSearching ? true : expanded.has(placement.placementId);
            const title = resolveTitle(placement);
            return (
              <div
                key={placement.placementId}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                className={`nts-row ${index === selectedIndex ? "selected" : ""} ${placement.isTrashed ? "trashed" : ""} ${placement.isArchived ? "archived" : ""}`}
                style={{ paddingLeft: 12 + row.depth * 18 }}
                role="option"
                aria-selected={index === selectedIndex}
                title={row.path.join(" / ")}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={(event) => openRow(row, event)}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className={`nts-toggle ${isExpanded ? "expanded" : ""}`}
                    aria-label={t(locale, isExpanded ? "collapseNote" : "expandNote")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleExpand(placement.placementId);
                    }}
                  >
                    <ChevronRight size={16} />
                  </button>
                ) : (
                  <span className="nts-toggle" aria-hidden="true" />
                )}
                {hasChildren || placement.isCalendar ? (
                  <Folder className="nts-icon" size={16} />
                ) : placement.type === "code" ? (
                  <Code2 className="nts-icon" size={16} />
                ) : (
                  <FileText className="nts-icon" size={16} />
                )}
                <span className="nts-title">{highlight(title)}</span>
                {isSearching && row.path.length > 0 && <span className="nts-path">{row.path.join(" / ")}</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="nts-footer">
        {isSearching && rows.length > 0 && <span className="nts-count">{t(locale, "newTabSearchCount", { count: String(rows.length) })}</span>}
        <button className="nts-new-note" type="button" disabled={creatingNote} onClick={() => void createNewNote()}>
          <Plus size={16} />
          {t(locale, "newNote")}
        </button>
      </div>
    </div>
  );
}
