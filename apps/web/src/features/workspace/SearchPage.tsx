import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type { SearchResult } from "@ygdria/shared";
import { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";

export function SearchPage({ client, locale, onOpenNote }: { client: YgdriaClient; locale: Locale; onOpenNote: (noteId: string) => void }) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const term = submittedQuery.trim();
  const canSearch = isSearchableQuery(query);
  const showingSubmittedResults = term.length > 0 && term === query.trim();
  const results = useQuery({
    queryKey: ["full-text-search", term],
    queryFn: () => client.search(term) as Promise<SearchResult[]>,
    enabled: term.length > 0,
    retry: false,
  });

  useEffect(() => inputRef.current?.focus(), []);

  return <article className="search-page">
    <h1>{t(locale, "searchTitle")}</h1>
    <form className="search-page-form" onSubmit={(event) => { event.preventDefault(); const next = query.trim(); if (!isSearchableQuery(next)) return; if (next === term) void results.refetch(); else setSubmittedQuery(next); }}>
      <label className="search-page-input">
        <Search size={20} aria-hidden="true" />
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(locale, "searchNotes")} aria-label={t(locale, "searchNotes")} />
      </label>
      <button type="submit" disabled={!canSearch}>{t(locale, "searchAction")}</button>
    </form>
    {!showingSubmittedResults ? (query.trim().length > 0 && !canSearch ? <p className="search-page-message">{t(locale, "minSearchLength")}</p> : <p className="search-page-message">{t(locale, "searchHint")}</p>) : results.isPending ? <p className="search-page-message">{t(locale, "loading")}</p> : results.isError ? <p className="search-page-message search-page-error">{t(locale, "searchFailed")} {results.error.message}</p> : results.data?.length ? <div className="search-results">{results.data.map((result) => <button type="button" key={result.noteId} className="search-result" onClick={() => onOpenNote(result.noteId)}>
      <strong>{result.title}</strong><span><Snippet value={result.snippet} /></span><time>{new Date(result.updatedAt).toLocaleString()}</time>
    </button>)}</div> : <p className="search-page-message">{t(locale, "searchNoResults")}</p>}
  </article>;
}

function isSearchableQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
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
