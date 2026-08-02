import React, { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

type ConfirmationDialogProps = {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmationDialog({
  title, message, cancelLabel, confirmLabel, onCancel, onConfirm,
}: ConfirmationDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" aria-describedby="confirmation-dialog-description" onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-dialog-icon"><AlertTriangle size={21} /></div>
        <div><h2 id="confirmation-dialog-title">{title}</h2><p id="confirmation-dialog-description">{message}</p></div>
        <div className="confirm-dialog-actions">
          <button type="button" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="danger" autoFocus onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
