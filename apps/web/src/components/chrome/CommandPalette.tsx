import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, Calendar, FilePlus2, History, Network, Paperclip, Search, Settings,
} from "lucide-react";
import { YgdriaClient } from "@ygdria/api-client";
import type { SearchResult } from "@ygdria/shared";
import { t, type Locale } from "../../lib/i18n";

/** Max FTS results shown in the notes section. */
const MAX_NOTE_RESULTS = 8;
/** Debounce before the query hits the server-side FTS index. */
const SEARCH_DEBOUNCE_MS = 180;

/**
 * Quick-jump command palette (Ctrl/Cmd+K). Fuzzy-free by design: note hits
 * come from the server's FTS index, commands match by plain substring.
 */
export function CommandPalette({
  open,
  onClose,
  locale,
  client,
  openNote,
  onCreateNote,
  onOpenTodayNote,
  onOpenSearch,
  onOpenGraph,
  onOpenHistory,
  onOpenArchive,
  onOpenAttachments,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  client: YgdriaClient;
  openNote: (noteId: string, isTrashed?: boolean, editing?: boolean) => void;
  onCreateNote: () => void;
  onOpenTodayNote: () => void;
  onOpenSearch: () => void;
  onOpenGraph: () => void;
  onOpenHistory: () => void;
  onOpenArchive: () => void;
  onOpenAttachments: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const term = query.trim();
  const termLower = term.toLocaleLowerCase();

  // Fresh state each time the palette opens; focus the input after mount.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Debounced server-side full-text search.
  useEffect(() => {
    if (!open || !term) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const found = await client.search(term, false);
        if (!cancelled) setResults(found.slice(0, MAX_NOTE_RESULTS));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, term, client]);

  const commands = useMemo(
    () =>
      [
        { id: "cmd:new-note", label: t(locale, "quickNewNote"), icon: <FilePlus2 size={16} />, run: onCreateNote },
        { id: "cmd:today", label: t(locale, "quickTodayNote"), icon: <Calendar size={16} />, run: onOpenTodayNote },
        { id: "cmd:search", label: t(locale, "quickActionSearch"), icon: <Search size={16} />, run: onOpenSearch },
        { id: "cmd:graph", label: t(locale, "graphView"), icon: <Network size={16} />, run: onOpenGraph },
        { id: "cmd:history", label: t(locale, "quickHistory"), icon: <History size={16} />, run: onOpenHistory },
        { id: "cmd:archive", label: t(locale, "archivedNotes"), icon: <Archive size={16} />, run: onOpenArchive },
        { id: "cmd:attachments", label: t(locale, "attachments"), icon: <Paperclip size={16} />, run: onOpenAttachments },
        { id: "cmd:settings", label: t(locale, "quickSettings"), icon: <Settings size={16} />, run: onOpenSettings },
      ].filter((command) => !termLower || command.label.toLocaleLowerCase().includes(termLower)),
    [locale, termLower, onCreateNote, onOpenTodayNote, onOpenSearch, onOpenGraph, onOpenHistory, onOpenArchive, onOpenAttachments, onOpenSettings],
  );

  const noteItems = useMemo(
    () =>
      results.map((result) => ({
        id: `note:${result.noteId}`,
        label: result.title || result.noteId,
        hint: result.snippet.replace(/<[^>]+>/g, "").trim(),
        run: () => openNote(result.noteId, false, true),
      })),
    [results, openNote],
  );

  const itemCount = commands.length + noteItems.length;

  useEffect(() => {
    if (activeIndex >= itemCount) setActiveIndex(Math.max(0, itemCount - 1));
  }, [activeIndex, itemCount]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results, query]);

  if (!open) return null;

  const runItem = (index: number) => {
    if (index < commands.length) commands[index]?.run();
    else noteItems[index - commands.length]?.run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (itemCount > 0) setActiveIndex((current) => (current + 1) % itemCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (itemCount > 0) setActiveIndex((current) => (current - 1 + itemCount) % itemCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(activeIndex);
    }
  };

  const renderItem = (
    item: { id: string; label: string; hint?: string; run: () => void; icon?: React.ReactNode },
    index: number,
  ) => (
    <button
      key={item.id}
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      className={`command-palette-item ${index === activeIndex ? "active" : ""}`}
      onMouseEnter={() => setActiveIndex(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => runItem(index)}
    >
      {item.icon}
      <span className="command-palette-label">
        <span>{item.label}</span>
        {item.hint && <small>{item.hint}</small>}
      </span>
    </button>
  );

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, "quickActionSearch")}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="command-palette-input">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder={t(locale, "commandPalettePlaceholder")}
            aria-label={t(locale, "quickActionSearch")}
            spellCheck={false}
          />
        </div>
        <div className="command-palette-list" ref={listRef} role="listbox" aria-label={t(locale, "commandPaletteCommands")}>
          {commands.length > 0 && <p className="command-palette-section">{t(locale, "commandPaletteCommands")}</p>}
          {commands.map((command, index) => renderItem(command, index))}
          {noteItems.length > 0 && <p className="command-palette-section">{t(locale, "commandPaletteNotes")}</p>}
          {noteItems.map((item, offset) => renderItem(item, commands.length + offset))}
          {term && !searching && noteItems.length === 0 && (
            <p className="command-palette-empty">{t(locale, "noMatchingNotes")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
