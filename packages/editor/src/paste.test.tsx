// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { YgdriaEditor } from "./YgdriaEditor.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("editor clipboard handling", () => {
  let root: Root | undefined;
  let editor: Editor;
  let host: HTMLDivElement;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });
  async function mount(props: Partial<ComponentProps<typeof YgdriaEditor>> = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <YgdriaEditor
          content={{ type: "doc", content: [{ type: "paragraph" }] }}
          locale="en"
          onEditorReady={(ready) => {
            editor = ready;
          }}
          {...props}
        />,
      ),
    );
  }
  async function paste({ text, html, image }: { text?: string; html?: string; image?: boolean }) {
    const data = new DataTransfer();
    if (text !== undefined) data.setData("text/plain", text);
    if (html !== undefined) data.setData("text/html", html);
    if (image) data.items.add(new File(["png"], "clipboard.png", { type: "image/png" }));
    await act(async () =>
      editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }
  async function menuPaste() {
    await act(async () =>
      editor.view.dom.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    const button = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find(
      (item) => item.querySelector("kbd")?.textContent === "Ctrl+V",
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  it.each(['<meta charset="utf-8">', '<input value="lost">', "<p></p>", "<p>&nbsp;</p>"])(
    "falls back to available plain text when HTML has no usable content: %s",
    async (html) => {
      await mount();
      await paste({ text: "keep <literal> & text\nsecond line", html });
      expect(editor.getText()).toContain("keep <literal> & text");
      expect(editor.getText()).toContain("second line");
      expect(editor.getJSON().content).toHaveLength(2);
    },
  );

  it("keeps rich formatting, links and tables instead of replacing them with plain text", async () => {
    await mount();
    await paste({
      text: "plain representation",
      html: '<p><strong>bold</strong> <a href="https://example.com">link</a></p><table><tr><td>cell</td></tr></table>',
    });
    expect(editor.getHTML()).toContain("<strong>bold</strong>");
    expect(editor.getHTML()).toContain('href="https://example.com"');
    expect(editor.getHTML()).toContain("<table");
    expect(editor.getText()).not.toContain("plain representation");
  });

  it("pastes ordinary plain text without HTML", async () => {
    await mount();
    await paste({ text: "ordinary <literal> text" });
    expect(editor.getText()).toBe("ordinary <literal> text");
  });

  it.each([true, false])(
    "does not let a bitmap representation swallow mixed text (has plain text=%s)",
    async (plain) => {
      const upload = vi.fn().mockRejectedValue(new Error("upload failed"));
      await mount({ onUploadImage: upload });
      await paste({
        text: plain ? "copied text" : undefined,
        html: "<p><strong>copied text</strong></p>",
        image: true,
      });
      expect(editor.getText()).toBe("copied text");
      expect(editor.getHTML()).toContain("<strong>");
      expect(upload).not.toHaveBeenCalled();
    },
  );

  it("preserves plain text even when accompanied by an image and unusable HTML", async () => {
    const upload = vi.fn();
    await mount({ onUploadImage: upload });
    await paste({ text: "survives", html: '<meta charset="utf-8">', image: true });
    expect(editor.getText()).toBe("survives");
    expect(upload).not.toHaveBeenCalled();
  });

  it("still uploads a standalone screenshot", async () => {
    const upload = vi.fn().mockResolvedValue("/api/v1/attachments/test-image");
    await mount({ onUploadImage: upload });
    await paste({ image: true });
    expect(upload).toHaveBeenCalledOnce();
    expect(editor.getHTML()).toContain("test-image");
  });

  it("reports screenshot upload failures without modifying existing content", async () => {
    const error = vi.fn();
    await mount({
      onUploadImage: vi.fn().mockRejectedValue(new Error("upload failed")),
      onUploadError: error,
    });
    const before = editor.getJSON();
    await paste({ image: true });
    expect(error).toHaveBeenCalledWith("upload failed");
    expect(editor.getJSON()).toEqual(before);
  });

  it("uses literal text for Ctrl+Shift+V, including angle brackets and newlines", async () => {
    await mount({ readClipboardText: vi.fn().mockResolvedValue("<b>literal</b>\nnext") });
    await act(async () => {
      editor.commands.keyboardShortcut("Mod-Shift-v");
    });
    expect(editor.getText()).toContain("<b>literal</b>");
    expect(editor.getJSON().content).toHaveLength(2);
    expect(editor.getHTML()).not.toContain("<b>");
  });

  it("falls back from empty HTML in the context menu", async () => {
    await mount({
      readClipboardHtml: vi.fn().mockResolvedValue('<meta charset="utf-8">'),
      readClipboardText: vi.fn().mockResolvedValue("menu <literal>"),
    });
    await menuPaste();
    expect(editor.getText()).toBe("menu <literal>");
  });

  it("keeps usable menu HTML without requiring a plain text read", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("unavailable"));
    await mount({
      readClipboardHtml: vi.fn().mockResolvedValue("<p><strong>menu rich text</strong></p>"),
      readClipboardText: readText,
    });
    await menuPaste();
    expect(editor.getHTML()).toContain("<strong>menu rich text</strong>");
    expect(readText).not.toHaveBeenCalled();
  });

  it("falls back to text when menu HTML reading is denied", async () => {
    await mount({
      readClipboardHtml: vi.fn().mockRejectedValue(new Error("denied")),
      readClipboardText: vi.fn().mockResolvedValue("fallback"),
    });
    await menuPaste();
    expect(editor.getText()).toBe("fallback");
  });

  it("does not paste into a read-only editor", async () => {
    const read = vi.fn().mockResolvedValue("unexpected");
    await mount({ readOnly: true, readClipboardText: read });
    await act(async () => {
      editor.commands.keyboardShortcut("Mod-Shift-v");
    });
    await paste({ text: "unexpected" });
    expect(read).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("");
  });

  it("reports a denied plain text clipboard read", async () => {
    const error = vi.fn();
    await mount({
      readClipboardText: vi.fn().mockRejectedValue(new Error("denied")),
      onUploadError: error,
    });
    await act(async () => {
      editor.commands.keyboardShortcut("Mod-Shift-v");
    });
    expect(error).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("");
  });
});
