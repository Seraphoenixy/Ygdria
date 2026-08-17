import { describe, it, expect } from "vitest";
import { Schema, Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection, tableNodes } from "@tiptap/pm/tables";
import { createTableSelection, getTableActions, selectTable, selectTableColumn, selectTableRow, TABLE_ACTION_LABELS } from "./table-actions.js";

// ---------------------------------------------------------------------------
// Real ProseMirror state helpers
// ---------------------------------------------------------------------------

const tableSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    ...tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} }),
  },
});

/** A doc with one paragraph followed by a 2×2 table (header row h1/h2, body row a/b). */
function tableDocument(): PmNode {
  const cell = (type: "table_header" | "table_cell", text: string) => ({
    type,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  return PmNode.fromJSON(tableSchema, {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "outside" }] },
      {
        type: "table",
        content: [
          { type: "table_row", content: [cell("table_header", "h1"), cell("table_header", "h2")] },
          { type: "table_row", content: [cell("table_cell", "a"), cell("table_cell", "b")] },
        ],
      },
    ],
  });
}

/** Editor state with the cursor inside the cell whose paragraph contains `text`. */
function stateInCell(text: string): EditorState {
  const doc = tableDocument();
  let cursor = 1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) cursor = pos + 1;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
}

function stateOutsideTable(): EditorState {
  const doc = tableDocument();
  return EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
}

function cellTexts(selection: CellSelection): string[] {
  const texts: string[] = [];
  selection.forEachCell((node) => texts.push(node.textContent));
  return texts;
}

/** Fake editor whose state is real, recording dispatched transactions. */
function fakeSelectionEditor(state: EditorState) {
  const dispatched: Transaction[] = [];
  const editor = {
    isDestroyed: false,
    isActive: (name: string) => name === "table",
    state,
    view: {
      dispatch: (transaction: Transaction) => {
        dispatched.push(transaction);
        return true;
      },
    },
  } as any;
  return { editor, dispatched };
}

// ---------------------------------------------------------------------------
// createTableSelection
// ---------------------------------------------------------------------------

describe("createTableSelection", () => {
  it("returns null when the cursor is outside a table", () => {
    expect(createTableSelection(stateOutsideTable(), "row")).toBeNull();
    expect(createTableSelection(stateOutsideTable(), "column")).toBeNull();
    expect(createTableSelection(stateOutsideTable(), "table")).toBeNull();
  });

  it("selects the whole row containing the cursor", () => {
    const selection = createTableSelection(stateInCell("a"), "row");
    expect(selection).toBeInstanceOf(CellSelection);
    expect(selection!.isRowSelection()).toBe(true);
    expect(cellTexts(selection!)).toEqual(["a", "b"]);
  });

  it("selects the header row when the cursor is in a header cell", () => {
    const selection = createTableSelection(stateInCell("h1"), "row");
    expect(cellTexts(selection!)).toEqual(["h1", "h2"]);
  });

  it("selects the whole column containing the cursor", () => {
    const selection = createTableSelection(stateInCell("h2"), "column");
    expect(selection).toBeInstanceOf(CellSelection);
    expect(selection!.isColSelection()).toBe(true);
    expect(cellTexts(selection!)).toEqual(["h2", "b"]);
  });

  it("selects every cell of the table", () => {
    const selection = createTableSelection(stateInCell("b"), "table");
    expect(cellTexts(selection!)).toEqual(["h1", "h2", "a", "b"]);
    expect(selection!.isRowSelection()).toBe(true);
    expect(selection!.isColSelection()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// select* command functions
// ---------------------------------------------------------------------------

describe("select command functions", () => {
  it("selectTableRow dispatches a row CellSelection", () => {
    const { editor, dispatched } = fakeSelectionEditor(stateInCell("a"));
    selectTableRow(editor);
    expect(dispatched).toHaveLength(1);
    const selection = dispatched[0].selection as CellSelection;
    expect(selection.isRowSelection()).toBe(true);
    expect(cellTexts(selection)).toEqual(["a", "b"]);
  });

  it("selectTableColumn dispatches a column CellSelection", () => {
    const { editor, dispatched } = fakeSelectionEditor(stateInCell("h2"));
    selectTableColumn(editor);
    const selection = dispatched[0].selection as CellSelection;
    expect(selection.isColSelection()).toBe(true);
    expect(cellTexts(selection)).toEqual(["h2", "b"]);
  });

  it("selectTable dispatches a selection covering every cell", () => {
    const { editor, dispatched } = fakeSelectionEditor(stateInCell("b"));
    selectTable(editor);
    const selection = dispatched[0].selection as CellSelection;
    expect(cellTexts(selection)).toEqual(["h1", "h2", "a", "b"]);
  });

  it("does not dispatch when the cursor is outside a table", () => {
    const { editor, dispatched } = fakeSelectionEditor(stateOutsideTable());
    selectTableRow(editor);
    selectTableColumn(editor);
    selectTable(editor);
    expect(dispatched).toHaveLength(0);
  });

  it("does not throw or dispatch for a null or destroyed editor", () => {
    expect(() => {
      selectTableRow(null);
      selectTableColumn(undefined);
      selectTable(null);
    }).not.toThrow();
    const { editor, dispatched } = fakeSelectionEditor(stateInCell("a"));
    editor.isDestroyed = true;
    selectTableRow(editor);
    expect(dispatched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal fake editor for testing getTableActions. */
function fakeEditor(overrides: Partial<{ isInTable: boolean }> = {}) {
  const calls: string[] = [];
  const methods = [
    "focus",
    "addRowBefore",
    "addRowAfter",
    "deleteRow",
    "addColumnBefore",
    "addColumnAfter",
    "deleteColumn",
  ];

  function createChain(): Record<string, () => any> {
    const chain: Record<string, () => any> = {};
    for (const method of methods) {
      chain[method] = () => {
        calls.push(method);
        return createChain();
      };
    }
    chain.run = () => {};
    return chain;
  }

  return {
    calls,
    isActive: (name: string) => {
      if (name === "table") return overrides.isInTable ?? false;
      return false;
    },
    chain: () => createChain(),
  } as any;
}

// ---------------------------------------------------------------------------
// getTableActions
// ---------------------------------------------------------------------------

describe("getTableActions", () => {
  it("reports isInTable false when editor is null", () => {
    const actions = getTableActions(null);
    expect(actions.isInTable).toBe(false);
  });

  it("reports isInTable false when editor is undefined", () => {
    const actions = getTableActions(undefined);
    expect(actions.isInTable).toBe(false);
  });

  it("reports isInTable false when cursor is outside a table", () => {
    const editor = fakeEditor({ isInTable: false });
    const actions = getTableActions(editor);
    expect(actions.isInTable).toBe(false);
  });

  it("reports isInTable true when cursor is inside a table", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    expect(actions.isInTable).toBe(true);
  });

  it("addRowBefore calls focus and addRowBefore on the chain", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    actions.addRowBefore();
    expect(editor.calls).toContain("focus");
    expect(editor.calls).toContain("addRowBefore");
  });

  it("addRowAfter calls focus and addRowAfter on the chain", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    actions.addRowAfter();
    expect(editor.calls).toContain("focus");
    expect(editor.calls).toContain("addRowAfter");
  });

  it("deleteRow calls focus and deleteRow on the chain", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    actions.deleteRow();
    expect(editor.calls).toContain("focus");
    expect(editor.calls).toContain("deleteRow");
  });

  it("addColumnBefore calls focus and addColumnBefore on the chain", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    actions.addColumnBefore();
    expect(editor.calls).toContain("focus");
    expect(editor.calls).toContain("addColumnBefore");
  });

  it("addColumnAfter calls focus and addColumnAfter on the chain", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    actions.addColumnAfter();
    expect(editor.calls).toContain("focus");
    expect(editor.calls).toContain("addColumnAfter");
  });

  it("deleteColumn calls focus and deleteColumn on the chain", () => {
    const editor = fakeEditor({ isInTable: true });
    const actions = getTableActions(editor);
    actions.deleteColumn();
    expect(editor.calls).toContain("focus");
    expect(editor.calls).toContain("deleteColumn");
  });

  it("does not throw when editor is null and actions are called", () => {
    const actions = getTableActions(null);
    expect(() => {
      actions.addRowBefore();
      actions.addRowAfter();
      actions.deleteRow();
      actions.addColumnBefore();
      actions.addColumnAfter();
      actions.deleteColumn();
      actions.selectRow();
      actions.selectColumn();
      actions.selectTable();
    }).not.toThrow();
  });

  it("select actions dispatch table selections through the editor view", () => {
    const { editor, dispatched } = fakeSelectionEditor(stateInCell("a"));
    const actions = getTableActions(editor);
    actions.selectRow();
    actions.selectColumn();
    actions.selectTable();
    expect(dispatched).toHaveLength(3);
    expect((dispatched[0].selection as CellSelection).isRowSelection()).toBe(true);
    expect((dispatched[1].selection as CellSelection).isColSelection()).toBe(true);
    expect(cellTexts(dispatched[2].selection as CellSelection)).toEqual(["h1", "h2", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// TABLE_ACTION_LABELS
// ---------------------------------------------------------------------------

describe("TABLE_ACTION_LABELS", () => {
  const expectedKeys = [
    "addRowBefore",
    "addRowAfter",
    "deleteRow",
    "addColumnBefore",
    "addColumnAfter",
    "deleteColumn",
    "selectRow",
    "selectColumn",
    "selectTable",
    "tableActions",
  ] as const;

  it("provides all expected keys for zh-CN", () => {
    for (const key of expectedKeys) {
      expect(TABLE_ACTION_LABELS["zh-CN"]).toHaveProperty(key);
      expect(typeof TABLE_ACTION_LABELS["zh-CN"][key]).toBe("string");
    }
  });

  it("provides all expected keys for en", () => {
    for (const key of expectedKeys) {
      expect(TABLE_ACTION_LABELS.en).toHaveProperty(key);
      expect(typeof TABLE_ACTION_LABELS.en[key]).toBe("string");
    }
  });

  it("zh-CN labels are non-empty", () => {
    for (const key of expectedKeys) {
      expect(TABLE_ACTION_LABELS["zh-CN"][key].length).toBeGreaterThan(0);
    }
  });

  it("en labels are non-empty", () => {
    for (const key of expectedKeys) {
      expect(TABLE_ACTION_LABELS.en[key].length).toBeGreaterThan(0);
    }
  });
});