import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Search, X } from "lucide-react";
import type { SearchResult } from "@ygdria/shared";
import { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";

export function SearchPage({ client, locale, isActive, onOpenNote, initialTag }: { client: YgdriaClient; locale: Locale; isActive: boolean; onOpenNote: (noteId: string, openInNewTab?: boolean) => void; initialTag?: string }) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<{ noteId: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const term = submittedQuery.trim();
  const canSearch = isSearchableQuery(query) || query.trim().startsWith("tag:");
  const showingSubmittedResults = term.length > 0 && term === query.trim();
  const results = useQuery({
    queryKey: ["full-text-search", term],
    queryFn: () => client.search(term) as Promise<SearchResult[]>,
    enabled: term.length > 0,
    retry: false,
  });

  // Handle initial tag from external navigation (e.g. clicking a tag on the new-tab page).
  useEffect(() => {
    if (initialTag) {
      const next = `tag:${initialTag}`;
      setQuery(next);
      setSubmittedQuery(next);
    }
  }, [initialTag]);

  useEffect(() => { if (isActive) inputRef.current?.focus(); }, [isActive]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const clearTagFilter = () => {
    setQuery("");
    setSubmittedQuery("");
    inputRef.current?.focus();
  };

  const isTagSearch = term.startsWith("tag:");

  return <article className="search-page">
    <h1>{t(locale, "searchTitle")}</h1>
    <form className="search-page-form" onSubmit={(event) => { event.preventDefault(); const next = query.trim(); if (!isSearchableQuery(next) && !next.startsWith("tag:")) return; if (next === term) void results.refetch(); else setSubmittedQuery(next); }}>
      <label className="search-page-input">
        <Search size={20} aria-hidden="true" />
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(locale, "searchNotes")} aria-label={t(locale, "searchNotes")} />
        {isTagSearch && (
          <button type="button" className="search-page-tag-clear" onClick={clearTagFilter} title={t(locale, "removeTag")}>
            <X size={16} />
          </button>
        )}
      </label>
      <button type="submit" disabled={!canSearch}>{t(locale, "searchAction")}</button>
    </form>
    {!showingSubmittedResults ? (query.trim().length > 0 && !canSearch ? <p className="search-page-message">{t(locale, "minSearchLength")}</p> : isTagSearch ? null : <p className="search-page-message">{t(locale, "searchHint")}</p>) : results.isPending ? <p className="search-page-message">{t(locale, "loading")}</p> : results.isError ? <p className="search-page-message search-page-error">{t(locale, "searchFailed")} {results.error.message}</p> : results.data?.length ? <div className="search-results">{results.data.map((result) => <button type="button" key={result.noteId} className="search-result" onClick={() => onOpenNote(result.noteId)} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ noteId: result.noteId, x: event.clientX, y: event.clientY }); }}>
      <strong>{result.title}</strong><span><Snippet value={result.snippet} /></span><time>{new Date(result.updatedAt).toLocaleString()}</time>
      {result.tags && result.tags.length > 0 && (
        <div className="search-result-tags">
          {result.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="tag-badge">{tag}</span>
          ))}
          {result.tags.length > 2 && (
            <span className="tag-badge tag-more">+{result.tags.length - 2}</span>
          )}
        </div>
      )}
    </button>)}</div> : <p className="search-page-message">{t(locale, "searchNoResults")}</p>}
    {contextMenu && (
      <div className="action-menu search-result-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <button role="menuitem" onClick={() => { onOpenNote(contextMenu.noteId, true); setContextMenu(null); }}>
          <ExternalLink size={16} /> {t(locale, "openInNewTab")}
        </button>
      </div>
    )}
  </article>;
}

function isSearchableQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("tag:")) return true;
  return !Array.from(trimmed.matchAll(/\p{Script=Han}+/gu), (match) => match[0]).some((term) => Array.from(term).length < 2);
}

function Snippet({ value }: { value: string }) {
  let marked = false;
  return <>{value.split(/(<mark>|<\/mark>)/).map((part, index) => {
    if (part === "<mark>") { marked = true; return null; }
    if (part === "</mark>") { marked = false; return null; }
    return marked ? <mark key={index}>{part}</mark> : part;
  })}</>;
}