import React, { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { YgdriaClient } from "@ygdria/api-client";
import type { RemoteProxyClient } from "../../app/RemoteProxyClient";
import { t, type Locale } from "../../lib/i18n";
import { DiffView } from "./DiffView";
import type { SyncConflict } from "../../hooks/useSync";

type SyncConflictsDialogProps = {
  conflicts: SyncConflict[];
  client: YgdriaClient;
  remoteClient: RemoteProxyClient | YgdriaClient;
  locale: Locale;
  onResolve: (noteId: string) => void;
  onClose: () => void;
};

type ResolvedSide = "keepMine" | "takeTheirs";

function formatLocalTime(ts: number, locale: Locale) {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(ts));
}

function SyncConflictCard({
  conflict,
  client,
  remoteClient,
  locale,
  onResolve,
}: {
  conflict: SyncConflict;
  client: YgdriaClient;
  remoteClient: RemoteProxyClient | YgdriaClient;
  locale: Locale;
  onResolve: (noteId: string) => void;
}) {
  const [theirs, setTheirs] = useState<{ version: number; content: unknown } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [resolving, setResolving] = useState<ResolvedSide | null>(null);

  useEffect(() => {
    let cancelled = false;
    remoteClient
      .getNote(conflict.noteId)
      .then((note) => {
        if (!cancelled) setTheirs({ version: note.version, content: note.content });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteClient, conflict.noteId]);

  const resolve = async (side: ResolvedSide) => {
    if (resolving) return;
    setResolving(side);
    try {
      // Protected notes are encrypted end-to-end: the plaintext is never on the
      // server, so we cannot re-upload a recovered edit. The local DB already
      // holds the remote ciphertext after the download phase, so acknowledging
      // the conflict (without a content write) is correct for both sides.
      if (!conflict.isProtected) {
        const local = await client.getNote(conflict.noteId);
        const isCode = conflict.noteType === "code";
        const value = side === "keepMine" ? conflict.mineContent : theirs?.content;
        const body = (isCode
          ? { expectedVersion: local.version, code: String(value ?? "") }
          : { expectedVersion: local.version, content: value }) as Parameters<
          typeof client.updateNote
        >[1];
        await client.updateNote(conflict.noteId, body);
      }
      onResolve(conflict.noteId);
    } catch {
      setResolving(null);
    }
  };

  return (
    <article className="sync-conflict-card">
      <h3 className="sync-conflict-title">
        {conflict.title || t(locale, "untitledNote")}
        {conflict.noteType === "code" ? (
          <span className="sync-conflict-tag">{t(locale, "untitledCodeNote")}</span>
        ) : null}
      </h3>
      <div className="conflict-dialog-body">
        {conflict.isProtected ? (
          <p className="conflict-protected-note">{t(locale, "syncConflictProtectedNote")}</p>
        ) : loadError ? (
          <p className="revision-error">{t(locale, "conflictLoadFailed")}</p>
        ) : !theirs ? (
          <p>{t(locale, "loading")}</p>
        ) : (
          <>
            <div className="conflict-legend">
              <span className="conflict-legend-remote">{t(locale, "syncConflictRemoteVersion")}</span>
              <span className="conflict-legend-local">{t(locale, "syncConflictMineVersion")}</span>
            </div>
            <div className="revision-diff">
              <DiffView
                oldContent={theirs.content}
                newContent={conflict.mineContent}
                locale={locale}
                emptyHint={t(locale, "conflictNoDiff")}
              />
            </div>
          </>
        )}
      </div>
      <footer className="conflict-actions">
        <span className="sync-conflict-detected">
          {t(locale, "syncConflictDetectedAt", { time: formatLocalTime(conflict.detectedAt, locale) })}
        </span>
        <div className="conflict-actions-primary">
          <button
            type="button"
            className="conflict-keepmine-btn"
            onClick={() => resolve("keepMine")}
            disabled={conflict.isProtected || resolving !== null}
          >
            {t(locale, "syncConflictKeepMine")}
          </button>
          <button
            type="button"
            className="conflict-taketheirs-btn"
            onClick={() => resolve("takeTheirs")}
            disabled={resolving !== null}
          >
            {t(locale, "syncConflictTakeTheirs")}
          </button>
        </div>
      </footer>
    </article>
  );
}

/**
 * Lists notes whose edit was silently overwritten by a newer remote version
 * during the last sync (last-write-wins). Each card shows a GitHub-style diff
 * of the remote (kept) version versus the user's discarded edit, and lets the
 * user consciously choose which side to keep instead of losing data silently.
 */
export function SyncConflictsDialog({
  conflicts,
  client,
  remoteClient,
  locale,
  onResolve,
  onClose,
}: SyncConflictsDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="conflict-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="conflict-dialog sync-conflicts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-conflicts-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="sync-conflicts-title">
              <AlertTriangle size={18} /> {t(locale, "syncConflictsTitle")}
              {conflicts.length ? ` (${conflicts.length})` : ""}
            </h2>
            <p>{t(locale, "syncConflictsHint")}</p>
          </div>
          <button
            type="button"
            className="revision-dialog-close"
            aria-label={t(locale, "close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="conflict-dialog-body sync-conflicts-body">
          {conflicts.length === 0 ? (
            <p className="revision-diff-hint">{t(locale, "syncConflictEmpty")}</p>
          ) : (
            conflicts.map((conflict) => (
              <SyncConflictCard
                key={conflict.noteId}
                conflict={conflict}
                client={client}
                remoteClient={remoteClient}
                locale={locale}
                onResolve={onResolve}
              />
            ))
          )}
        </div>
        <footer className="conflict-actions">
          <span />
          <div className="conflict-actions-primary">
            <button type="button" className="conflict-dismiss-btn" onClick={onClose}>
              {t(locale, "syncConflictLater")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
