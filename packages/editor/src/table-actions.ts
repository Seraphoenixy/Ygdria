import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { CellSelection, isInTable, selectedRect } from "@tiptap/pm/tables";

export type TableSelectionKind = "row" | "column" | "table";

export interface TableActions {
  isInTable: boolean;
  addRowBefore: () => void;
  addRowAfter: () => void;
  deleteRow: () => void;
  addColumnBefore: () => void;
  addColumnAfter: () => void;
  deleteColumn: () => void;
  selectRow: () => void;
  selectColumn: () => void;
  selectTable: () => void;
}

/**
 * Build a CellSelection covering the whole row, column, or table that
 * contains the current selection. Returns null when the selection is not
 * inside a table.
 */
export function createTableSelection(state: EditorState, kind: TableSelectionKind): CellSelection | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  const map = rect.map;
  const anchorRow = kind === "row" ? rect.top : 0;
  const headRow = kind === "row" ? rect.bottom - 1 : map.height - 1;
  const anchorCol = kind === "column" ? rect.left : 0;
  const headCol = kind === "column" ? rect.right - 1 : map.width - 1;
  const table = state.doc.nodeAt(rect.tableStart);
  if (!table) return null;
  const anchorPos = rect.tableStart + map.positionAt(anchorRow, anchorCol, table);
  const headPos = rect.tableStart + map.positionAt(headRow, headCol, table);
  return new CellSelection(state.doc.resolve(anchorPos), state.doc.resolve(headPos));
}

function dispatchTableSelection(editor: Editor | null | undefined, kind: TableSelectionKind): void {
  if (!editor || editor.isDestroyed) return;
  const selection = createTableSelection(editor.state, kind);
  if (!selection) return;
  editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
}

/** Select the entire row containing the cursor. */
export const selectTableRow = (editor: Editor | null | undefined): void => dispatchTableSelection(editor, "row");

/** Select the entire column containing the cursor. */
export const selectTableColumn = (editor: Editor | null | undefined): void => dispatchTableSelection(editor, "column");

/** Select every cell of the table containing the cursor. */
export const selectTable = (editor: Editor | null | undefined): void => dispatchTableSelection(editor, "table");

export function getTableActions(editor: Editor | null | undefined): TableActions {
  const isInTableActive = editor?.isActive("table") ?? false;

  return {
    isInTable: isInTableActive,
    addRowBefore: () => editor?.chain().focus().addRowBefore().run(),
    addRowAfter: () => editor?.chain().focus().addRowAfter().run(),
    deleteRow: () => editor?.chain().focus().deleteRow().run(),
    addColumnBefore: () => editor?.chain().focus().addColumnBefore().run(),
    addColumnAfter: () => editor?.chain().focus().addColumnAfter().run(),
    deleteColumn: () => editor?.chain().focus().deleteColumn().run(),
    selectRow: () => selectTableRow(editor),
    selectColumn: () => selectTableColumn(editor),
    selectTable: () => selectTable(editor),
  };
}

export const TABLE_ACTION_LABELS = {
  "zh-CN": {
    addRowBefore: "在上方插入行",
    addRowAfter: "在下方插入行",
    deleteRow: "删除当前行",
    addColumnBefore: "在左侧插入列",
    addColumnAfter: "在右侧插入列",
    deleteColumn: "删除当前列",
    selectRow: "选择当前行",
    selectColumn: "选择当前列",
    selectTable: "选择整个表格",
    tableActions: "表格操作",
  },
  en: {
    addRowBefore: "Insert row above",
    addRowAfter: "Insert row below",
    deleteRow: "Delete row",
    addColumnBefore: "Insert column left",
    addColumnAfter: "Insert column right",
    deleteColumn: "Delete column",
    selectRow: "Select row",
    selectColumn: "Select column",
    selectTable: "Select table",
    tableActions: "Table actions",
  },
};
