import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { History, X, RotateCcw, Search } from "lucide-react";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import { buildHunks, lcsDiff, linesFromContent, revertHunk, type DiffHunk, DiffView } from "./DiffView";

type RevisionHistoryDialogProps = {
  client: YgdriaClient;
  locale: Locale;
  note: { id: string; type: "text" | "code" | "file"; version: number; isProtected?: boolean; content: unknown };
  queryClient: QueryClient;
  onClose: () => void;
};

export function RevisionHistoryDialog({ client, locale, note, queryClient, onClose }: RevisionHistoryDialogProps) {
  const [selectedRevisionId, setSelectedRevisionId] = useState<string>();
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [diffQuery, setDiffQuery] = useState("");
  const revisions = useQuery({ queryKey: ["revisions", note.id], queryFn: () => client.revisions(note.id) });
  const revision = useQuery({
    queryKey: ["revision", note.id, selectedRevisionId],
    queryFn: () => client.revisionContent(note.id, selectedRevisionId!),
    enabled: Boolean(selectedRevisionId),
  });

  useEffect(() => {
    if (!selectedRevisionId && revisions.data?.[0]) setSelectedRevisionId(revisions.data[0].id);
  }, [revisions.data, selectedRevisionId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const isCode = note.type === "code";
  const currentLines = useMemo(() => linesFromContent(note.content), [note.content]);
  const hunks = useMemo(() => {
    if (!revision.data) return [] as DiffHunk[];
    const oldLines = linesFromContent(revision.data.content);
    return buildHunks(lcsDiff(oldLines, currentLines));
  }, [note.content, revision.data]);
  const filteredHunks = useMemo(() => {
    const query = diffQuery.trim().toLowerCase();
    return hunks.map((hunk, originalIndex) => ({ hunk, originalIndex })).filter(({ hunk }) =>
      !query || hunk.lines.some((line) => line.text.toLowerCase().includes(query)),
    );
  }, [hunks, diffQuery]);

  const invalidateAfterRevert = () => {
    queryClient.invalidateQueries({ queryKey: ["note", note.id] });
    queryClient.invalidateQueries({ queryKey: ["revisions", note.id] });
  };

  const revertHunkMutation = useMutation({
    mutationFn: async (hunkIndex: number) => {
      const reverted = revertHunk(currentLines, hunks[hunkIndex]);
      await client.updateNote(note.id, { code: reverted, expectedVersion: note.version });
    },
    onSuccess: invalidateAfterRevert,
  });

  const restoreRevisionMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRevisionId) return;
      await client.restoreRevision(note.id, selectedRevisionId, note.version);
    },
    onSuccess: invalidateAfterRevert,
  });

  const canFullRestore = !note.isProtected && (note.type === "text" || note.type === "code");
  const timeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const revertError = revertHunkMutation.error ?? restoreRevisionMutation.error;

  return (
    <div className="revision-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="revision-dialog" role="dialog" aria-modal="true" aria-labelledby="revision-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="revision-dialog-title"><History size={18} /> {t(locale, "viewRevisionHistory")}</h2>
            <p>{t(locale, "revisionHistoryHint")}</p>
          </div>
          <div className="revision-dialog-actions">
            <button
              type="button"
              className="revision-mode-btn"
              onClick={() => setDiffMode((mode) => (mode === "unified" ? "split" : "unified"))}
              aria-pressed={diffMode === "split"}
              title={diffMode === "unified" ? t(locale, "diffModeSplit") : t(locale, "diffModeUnified")}
            >
              {diffMode === "unified" ? t(locale, "diffModeSplit") : t(locale, "diffModeUnified")}
            </button>
            {canFullRestore && (
              <button
                type="button"
                className="revision-restore-btn"
                onClick={() => restoreRevisionMutation.mutate()}
                disabled={!selectedRevisionId || restoreRevisionMutation.isPending}
                title={t(locale, "revertRevisionTitle")}
              >
                <RotateCcw size={15} /> {restoreRevisionMutation.isPending ? t(locale, "reverting") : t(locale, "revertRevision")}
              </button>
            )}
            <button type="button" className="revision-dialog-close" aria-label={t(locale, "close")} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="revision-dialog-body">
          <aside aria-label={t(locale, "noteRevisions")}>
            {revisions.isLoading ? (
              <p>{t(locale, "loading")}</p>
            ) : revisions.data?.length ? (
              <ol>
                {revisions.data.map((item, index) => (
                  <li key={item.id}>
                    <button type="button" className={selectedRevisionId === item.id ? "selected" : ""} onClick={() => setSelectedRevisionId(item.id)}>
                      <strong>{index === 0 ? t(locale, "latestRevision") : t(locale, "revision")}</strong>
                      <time>{timeFormat.format(new Date(item.createdAt))}</time>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{t(locale, "noRevisions")}</p>
            )}
          </aside>
          <div className="revision-diff">
            {revision.data && (
              <div className="revision-search">
                <Search size={14} />
                <input
                  type="search"
                  value={diffQuery}
                  onChange={(event) => setDiffQuery(event.target.value)}
                  placeholder={t(locale, "revisionSearch")}
                  aria-label={t(locale, "revisionSearch")}
                />
                {diffQuery.trim() && (
                  <span className="revision-search-count">
                    {t(locale, "revisionSearchMatches", {
                      count: String(filteredHunks.length),
                      total: String(hunks.length),
                    })}
                  </span>
                )}
              </div>
            )}
            {revision.isLoading ? (
              <p>{t(locale, "loading")}</p>
            ) : revision.data ? (
              <>
                {!isCode && <p className="revision-diff-hint">{t(locale, "codeOnlyRevertHint")}</p>}
                {diffQuery.trim() && filteredHunks.length === 0 ? (
                  <p className="revision-diff-hint">{t(locale, "revisionSearchNoMatch")}</p>
                ) : (
                  <DiffView
                    hunks={filteredHunks.map((entry) => entry.hunk)}
                    locale={locale}
                    mode={diffMode}
                    onRevertHunk={isCode ? (hi) => revertHunkMutation.mutate(filteredHunks[hi].originalIndex) : undefined}
                    revertHunkLabel={t(locale, "revertHunk")}
                    revertHunkTitle={t(locale, "revertHunkTitle")}
                    isReverting={revertHunkMutation.isPending}
                  />
                )}
              </>
            ) : (
              <p>{t(locale, "selectRevision")}</p>
            )}
            {revertError && <p className="revision-error">{t(locale, "revertFailed")}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
