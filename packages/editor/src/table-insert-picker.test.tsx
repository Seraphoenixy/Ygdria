// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { TableInsertPicker } from "./TableInsertPicker.js";
import { EditorToolbar } from "./EditorToolbar.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: "<p>hello</p>",
    editable: true,
  });
}

function tableCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "table") count += 1;
  });
  return count;
}

describe("TableInsertPicker click", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("inserts a table when a grid cell is clicked", () => {
    editor = makeEditor();
    editor.commands.focus("start");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<TableInsertPicker editor={editor!} locale="zh-CN" label="表格" />);
    });

    // Open the picker.
    const trigger = host.querySelector("button") as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const panel = document.querySelector(".editor-table-picker-panel");
    expect(panel).toBeTruthy();

    const cells = Array.from(panel!.querySelectorAll(".editor-table-picker-grid button")) as HTMLButtonElement[];
    expect(cells.length).toBe(48);

    // Click the cell representing 2 rows x 2 cols (index = (2-1)*8 + (2-1) = 9).
    const target = cells[9];
    act(() => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(tableCount(editor)).toBe(1);
  });
});

describe("TableInsertPicker inside the overflow panel", () => {
  let editor: Editor | null = null;
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  // Regression: when the toolbar overflows (narrow editor), the picker lives
  // inside the "more" panel and its grid in a separate portal. A pointerdown
  // on a grid cell must not tear down the panel before the click handler runs.
  it("still inserts when the grid survives a document-level pointerdown", () => {
    editor = makeEditor();
    editor.commands.focus("start");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<EditorToolbar editor={editor!} locale="zh-CN" />);
    });

    // Open the "more" overflow panel (clientWidth is 0 in happy-dom, so the
    // toolbar is in its most compact overflow level and hosts the picker).
    const moreTrigger = host.querySelector(".editor-toolbar-more-trigger button") as HTMLButtonElement;
    expect(moreTrigger).toBeTruthy();
    act(() => {
      moreTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const pickerTrigger = document.querySelector(
      '.editor-toolbar-overflow-panel button[aria-label="表格"]',
    ) as HTMLButtonElement;
    expect(pickerTrigger).toBeTruthy();
    act(() => {
      pickerTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const panel = document.querySelector(".editor-table-picker-panel");
    expect(panel).toBeTruthy();

    const cells = Array.from(panel!.querySelectorAll(".editor-table-picker-grid button")) as HTMLButtonElement[];
    expect(cells.length).toBe(48);
    const target = cells[9];

    // pointerdown fires before click; the toolbar's document-level close
    // listener must keep the overflow panel (and thus the picker) mounted.
    act(() => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector(".editor-toolbar-overflow-panel")).toBeTruthy();
    expect(document.querySelector(".editor-table-picker-panel")).toBeTruthy();

    act(() => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(tableCount(editor)).toBe(1);
  });
});
