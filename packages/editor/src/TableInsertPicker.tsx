import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { Table } from "lucide-react";

type Locale = "zh-CN" | "en";

const PICKER_ROWS = 6;
const PICKER_COLS = 8;

const PICKER_LABELS = {
  "zh-CN": {
    caption: (rows: number, cols: number) => `${rows} 行 × ${cols} 列`,
    hint: "拖动选择行列数",
  },
  en: {
    caption: (rows: number, cols: number) => `${rows} × ${cols}`,
    hint: "Drag to pick size",
  },
};

/**
 * Toolbar trigger that opens a row × column grid popover. Hovering previews
 * the table size; clicking inserts a table of that size with a header row.
 */
export function TableInsertPicker({
  editor,
  locale,
  label,
  onInserted,
}: {
  editor: Editor;
  locale: Locale;
  label: string;
  /** Called after a table was inserted (e.g. to close an overflow panel). */
  onInserted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const labels = PICKER_LABELS[locale];

  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPanelStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 180)),
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if ((target as Element)?.closest?.(".editor-table-picker-panel")) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const insert = () => {
    const rows = hover?.rows ?? 3;
    const cols = hover?.cols ?? 3;
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setOpen(false);
    setHover(null);
    onInserted?.();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={open ? "is-active" : undefined}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Table size={16} />
      </button>
      {open &&
        createPortal(
          <div
            className="editor-table-picker-panel"
            role="dialog"
            aria-label={label}
            style={panelStyle}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseLeave={() => setHover(null)}
          >
            <div className="editor-table-picker-grid" style={{ gridTemplateColumns: `repeat(${PICKER_COLS}, 14px)` }}>
              {Array.from({ length: PICKER_ROWS * PICKER_COLS }, (_, index) => {
                const rows = Math.floor(index / PICKER_COLS) + 1;
                const cols = (index % PICKER_COLS) + 1;
                const active = hover !== null && rows <= hover.rows && cols <= hover.cols;
                return (
                  <button
                    key={index}
                    type="button"
                    className={active ? "is-active" : undefined}
                    aria-label={`${rows} × ${cols}`}
                    onMouseEnter={() => setHover({ rows, cols })}
                    onClick={insert}
                  />
                );
              })}
            </div>
            <span className="editor-table-picker-caption">
              {hover ? labels.caption(hover.rows, hover.cols) : labels.hint}
            </span>
          </div>,
          document.body,
        )}
    </>
  );
}
