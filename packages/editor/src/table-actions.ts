import type { Editor } from "@tiptap/core";

export interface TableActions {
  isInTable: boolean;
  addRowBefore: () => void;
  addRowAfter: () => void;
  deleteRow: () => void;
  addColumnBefore: () => void;
  addColumnAfter: () => void;
  deleteColumn: () => void;
}

export function getTableActions(editor: Editor | null | undefined): TableActions {
  const isInTable = editor?.isActive("table") ?? false;

  return {
    isInTable,
    addRowBefore: () => editor?.chain().focus().addRowBefore().run(),
    addRowAfter: () => editor?.chain().focus().addRowAfter().run(),
    deleteRow: () => editor?.chain().focus().deleteRow().run(),
    addColumnBefore: () => editor?.chain().focus().addColumnBefore().run(),
    addColumnAfter: () => editor?.chain().focus().addColumnAfter().run(),
    deleteColumn: () => editor?.chain().focus().deleteColumn().run(),
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
    tableActions: "表格操作",
  },
  en: {
    addRowBefore: "Insert row above",
    addRowAfter: "Insert row below",
    deleteRow: "Delete row",
    addColumnBefore: "Insert column left",
    addColumnAfter: "Insert column right",
    deleteColumn: "Delete column",
    tableActions: "Table actions",
  },
};