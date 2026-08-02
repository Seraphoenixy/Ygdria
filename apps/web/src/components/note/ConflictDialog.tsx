import React, { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import { DiffView } from "./DiffView";
import type { SaveConflict } from "../../hooks/useNotes";

type ConflictDialogProps = {
  client: YgdriaClient;
  locale: Locale;
  conflict: SaveConflict;
  onResolve: (resolution: "keepMine" | "takeTheirs" | "dismiss", serverVersion?: number) => void;
  onClose: () => void;
};

/**
 * Surfaces an optimistic-lock conflict (the note changed elsewhere) instead of
 * silently losing the user's edits. Shows a GitHub-style diff of the server's
 * current content versus the user's unsaved local content, and lets the user
 * choose how to resolve it.
 */
export function ConflictDialog({ client, locale, conflict, onResolve, onClose }: ConflictDialogProps) {
  const [serverNote, setServerNote] = useState<{ version: number; content: unknown } | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .getNote(conflict.noteId)
      .then((note) => {
        if (!cancelled) setServerNote({ version: note.version, content: note.content });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, conflict.noteId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const isCode = conflict.type === "code";
  const localForDiff =
    isCode && conflict.localContent && typeof conflict.localContent !== "string"
      ? conflict.localContent.code
      : conflict.localContent;
  const canDiff = !conflict.isProtected && serverNote && !loadError;

  const keepMine = () => {
    if (!serverNote) return;
    onResolve("keepMine", serverNote.version);
  };

  return (
    <div className="conflict-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="conflict-dialog-title">
              <AlertTriangle size={18} /> {t(locale, "saveConflict")}
            </h2>
            <p>{t(locale, "saveConflictHint")}</p>
          </div>
          <button type="button" className="revision-dialog-close" aria-label={t(locale, "close")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="conflict-dialog-body">
          {conflict.isProtected ? (
            <p className="conflict-protected-note">{t(locale, "conflictProtectedNote")}</p>
          ) : loadError ? (
            <p className="revision-error">{t(locale, "conflictLoadFailed")}</p>
          ) : !serverNote ? (
            <p>{t(locale, "loading")}</p>
          ) : (
            <>
              <div className="conflict-legend">
                <span className="conflict-legend-remote">{t(locale, "conflictServerVersion")}</span>
                <span className="conflict-legend-local">{t(locale, "conflictLocalVersion")}</span>
              </div>
              <div className="revision-diff">
                <DiffView
                  oldContent={serverNote.content}
                  newContent={localForDiff}
                  locale={locale}
                  emptyHint={t(locale, "conflictNoDiff")}
                />
              </div>
            </>
          )}
        </div>
        <footer className="conflict-actions">
          <button type="button" className="conflict-dismiss-btn" onClick={() => onResolve("dismiss")}>
            {t(locale, "dismissConflict")}
          </button>
          <div className="conflict-actions-primary">
            <button type="button" className="conflict-taketheirs-btn" onClick={() => onResolve("takeTheirs")}>
              {t(locale, "takeServerVersion")}
            </button>
            <button type="button" className="conflict-keepmine-btn" onClick={keepMine} disabled={!serverNote || loadError}>
              {t(locale, "keepMyChanges")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
