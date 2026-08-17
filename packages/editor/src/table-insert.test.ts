// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";

function makeEditor(content = "<p>hello</p>"): Editor {
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
    content,
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

describe("insertTable reproduction", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("inserts while focused", () => {
    editor = makeEditor();
    editor.commands.focus("start");
    const ok = editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    expect(ok).toBe(true);
    expect(tableCount(editor)).toBe(1);
  });

  it("inserts after the editor was blurred", () => {
    editor = makeEditor();
    editor.commands.focus("start");
    // Simulate the user clicking the toolbar/picker: focus leaves the editor.
    editor.commands.blur();
    const ok = editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    expect(ok).toBe(true);
    expect(tableCount(editor)).toBe(1);
  });

  const positions: Array<[string, string]> = [
    ["empty paragraph", "<p></p>"],
    ["inside heading", "<h1>title</h1>"],
    ["inside list item", "<ul><li>item</li></ul>"],
    ["inside blockquote", "<blockquote>quote</blockquote>"],
    ["cursor at doc end", "<p>hello</p>"],
  ];

  for (const [label, content] of positions) {
    it(`inserts when the cursor is ${label}`, () => {
      editor = makeEditor(content);
      editor.commands.focus("end");
      let threw: unknown = null;
      let ok = false;
      try {
        ok = editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeNull();
      expect(ok).toBe(true);
      expect(tableCount(editor)).toBe(1);
    });
  }
});
