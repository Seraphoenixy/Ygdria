import { describe, it, expect } from "vitest";
import { getTableActions, TABLE_ACTION_LABELS } from "./table-actions.js";

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
    }).not.toThrow();
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