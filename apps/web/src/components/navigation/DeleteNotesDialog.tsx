import React, { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";

type DeleteNotesDialogProps = {
  placements: TreePlacement[];
  locale: Locale;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteNotesDialog({ placements, locale, onCancel, onConfirm }: DeleteNotesDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  const message = placements.length === 1
    ? t(locale, "deleteConfirm", { title: placements[0].title })
    : t(locale, "deleteConfirmMultiple", { count: String(placements.length) });

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-icon"><AlertTriangle size={21} /></div>
        <div>
          <h2 id="delete-dialog-title">{t(locale, "deleteNote")}</h2>
          <p id="delete-dialog-description">{message}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" onClick={onCancel}>{t(locale, "cancel")}</button>
          <button type="button" className="danger" autoFocus onClick={onConfirm}>{t(locale, "deleteNote")}</button>
        </div>
      </section>
    </div>
  );
}
