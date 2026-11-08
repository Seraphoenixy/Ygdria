// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { markdownToTiptap } from "./markdown.js";
import { NoteReference } from "./NoteReference.js";
import { YgdriaEditor } from "./YgdriaEditor.js";
import { StaticDocument } from "./renderer.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("note reference navigation", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  const content = markdownToTiptap("资源入口：[[note:target-id|阅读与小说]]").document;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });
  const mount = async (element: React.ReactNode) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(element));
  };
  const activate = async (keyboard: boolean) => {
    const link = host.querySelector<HTMLElement>(".note-reference")!;
    expect(link.dataset.noteId).toBe("target-id");
    expect(link.textContent).toBe("阅读与小说");
    expect(link.getAttribute("role")).toBe("link");
    expect(link.tabIndex).toBe(0);
    await act(async () => {
      if (keyboard) {
        link.focus();
        link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      } else {
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    });
  };

  it.each([true, false])("opens imported references by mouse and keyboard with readOnly=%s without saving", async (readOnly) => {
    const navigate = vi.fn();
    const save = vi.fn();
    await mount(<YgdriaEditor content={content} readOnly={readOnly} onNavigateNote={navigate} onSave={save} />);
    save.mockClear();
    await activate(false);
    await activate(true);
    expect(navigate.mock.calls).toEqual([["target-id"], ["target-id"]]);
    expect(save).not.toHaveBeenCalled();
  });

  it("uses the current navigation callback after rerendering", async () => {
    const first = vi.fn();
    const next = vi.fn();
    await mount(<YgdriaEditor content={content} onNavigateNote={first} />);
    await act(async () => root!.render(<YgdriaEditor content={content} onNavigateNote={next} />));
    await activate(false);
    expect(first).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith("target-id");
  });

  it("opens references in static previews without bubbling to parent navigation", async () => {
    const navigate = vi.fn();
    const parent = vi.fn();
    await mount(<div onClick={parent}><StaticDocument document={content} onNavigateNote={navigate} /></div>);
    await activate(false);
    await activate(true);
    expect(navigate.mock.calls).toEqual([["target-id"], ["target-id"]]);
    expect(parent).not.toHaveBeenCalled();
  });

  it("preserves the target and title when copying reference HTML back into the editor", () => {
    const editor = new Editor({ extensions: [StarterKit, NoteReference], content: content as JSONContent });
    try {
      const html = editor.getHTML();
      expect(html).toContain('data-note-id="target-id"');
      editor.commands.setContent(html);
      expect(editor.getJSON()).toEqual(content);
    } finally {
      editor.destroy();
    }
  });

  it("does not turn literal reference text into a navigation control", async () => {
    const navigate = vi.fn();
    await mount(<StaticDocument document={markdownToTiptap("`[[note:target-id|literal]]`").document} onNavigateNote={navigate} />);
    expect(host.querySelector(".note-reference")).toBeNull();
    await act(async () => host.querySelector("code")!.click());
    expect(navigate).not.toHaveBeenCalled();
  });
});
