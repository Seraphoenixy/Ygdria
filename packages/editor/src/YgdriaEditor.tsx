import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Highlight } from "@tiptap/extension-highlight";
import { TextAlign } from "@tiptap/extension-text-align";
import { Underline } from "@tiptap/extension-underline";
import { TextStyle, Color, FontSize } from "@tiptap/extension-text-style";
import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { NoteContent } from "@ygdria/shared";
import { normalizePastedHtml } from "./clipboard.js";
import { markdownToTiptap, tiptapToMarkdown } from "./markdown.js";
import { YgdriaCodeBlock } from "./CodeBlock.js";
import { SearchReplace, SearchReplaceBar } from "./SearchReplaceBar.js";
import { Redacted } from "./Redacted.js";
import katex from "katex";
// @ts-ignore
import "katex/dist/katex.min.css";

type EditorContextMenu = { x: number; y: number; hasSelection: boolean } | null;

const ClipboardShortcuts = Extension.create({
  name: "clipboardShortcuts",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-v": () => {
        navigator.clipboard.readText().then((text) => {
          this.editor.commands.insertContent(text);
        }).catch(() => {
          // Clipboard API may reject in insecure contexts
        });
        return true;
      },
    };
  },
});

const Indent = Extension.create({
  name: "indent",
  addCommands() {
    return {
      indent:
        () =>
        ({ editor }: { editor: any }) => {
          return editor.commands.sinkListItem("listItem");
        },
      outdent:
        () =>
        ({ editor }: { editor: any }) => {
          return editor.commands.liftListItem("listItem");
        },
    } as any;
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => (this.editor.commands as any).sinkListItem("listItem"),
      "Shift-Tab": () => (this.editor.commands as any).liftListItem("listItem"),
    };
  },
});

const NoteReference = Node.create({
  name: "noteReference",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return { noteId: { default: null }, title: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-note-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ class: "note-reference" }, HTMLAttributes),
      HTMLAttributes.title,
    ];
  },
});

// Attachment URLs require an authenticated fetch. Do not place them in an
// image's `src` during initial rendering: browsers cannot add API credentials
// to that request. The resolver below replaces this source with an object URL.
const AuthenticatedImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const source = HTMLAttributes.src;
    if (typeof source === "string" && /\/api\/v1\/attachments\/[^/?#]+(?:[?#].*)?$/i.test(source)) {
      const { src: _src, ...attributes } = HTMLAttributes;
      return ["img", { ...attributes, src: "", "data-ygdria-source": source }];
    }
    return ["img", HTMLAttributes];
  },
});

function MathNodeView({ node }: NodeViewProps) {
  const displayMode = node.type.name === "mathBlock";
  const html = katex.renderToString(node.attrs.formula ?? "", {
    displayMode,
    throwOnError: false,
    trust: false,
  });
  return <NodeViewWrapper as={displayMode ? "div" : "span"} className={`ygdria-math ${displayMode ? "ygdria-math-block" : "ygdria-math-inline"}`} contentEditable={false} dangerouslySetInnerHTML={{ __html: html }} />;
}

const MathInline = Node.create({
  name: "mathInline",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() { return { formula: { default: "" } }; },
  parseHTML() { return [{ tag: "span[data-math-inline]" }]; },
  renderHTML({ HTMLAttributes }) { return ["span", { "data-math-inline": "", "data-formula": HTMLAttributes.formula }]; },
  addNodeView() { return ReactNodeViewRenderer(MathNodeView); },
});

const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  addAttributes() { return { formula: { default: "" } }; },
  parseHTML() { return [{ tag: "div[data-math-block]" }]; },
  renderHTML({ HTMLAttributes }) { return ["div", { "data-math-block": "", "data-formula": HTMLAttributes.formula }]; },
  addNodeView() { return ReactNodeViewRenderer(MathNodeView); },
});

function normalizeMathContent(content: NoteContent): NoteContent {
  const splitInlineMath = (node: any) => {
    if (node?.type !== "text" || typeof node.text !== "string") return [normalizeNode(node)];
    const formulaPattern = /(?<!\\)\$([^$\n]+?)\$/g;
    const parts: any[] = [];
    let position = 0;
    let match: RegExpExecArray | null;
    while ((match = formulaPattern.exec(node.text))) {
      if (match.index > position) parts.push({ ...node, text: node.text.slice(position, match.index) });
      parts.push({ type: "mathInline", attrs: { formula: match[1].trim() } });
      position = match.index + match[0].length;
    }
    if (position === 0) return [node];
    if (position < node.text.length) parts.push({ ...node, text: node.text.slice(position) });
    return parts;
  };
  const normalizeNode = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    const hasMalformedMath = node.type === "paragraph" && (node.content ?? []).some(
      (child: any) => child.type === "mathInline" && /[\u3400-\u9fff\u3000-\u303f“”]/.test(child.attrs?.formula ?? ""),
    );
    if (hasMalformedMath) {
      const restored = (node.content ?? []).map((child: any) =>
        child.type === "mathInline" ? `$${child.attrs?.formula ?? ""}$` : child.type === "text" ? child.text ?? "" : "",
      ).join("");
      return normalizeNode({ ...node, content: [{ type: "text", text: restored }] });
    }
    const text = node.type === "paragraph"
      ? (node.content ?? []).every((child: any) => child.type === "text")
        ? (node.content ?? []).map((child: any) => child.text ?? "").join("")
        : ""
      : "";
    const blockFormula = text.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
    if (blockFormula) return { type: "mathBlock", attrs: { formula: blockFormula[1].trim() } };
    if (!Array.isArray(node.content)) return node;
    return { ...node, content: node.content.flatMap(splitInlineMath) };
  };
  return normalizeNode(content) as NoteContent;
}

export function YgdriaEditor({
  content,
  onSave,
  locale = "zh-CN",
  onUploadImage,
  resolveImageSrc,
  onEditorReady,
  readOnly = false,
  markdownView = false,
  documentId,
}: {
  content: NoteContent;
  onSave?: (content: NoteContent) => void;
  locale?: "zh-CN" | "en";
  onUploadImage?: (file: File) => Promise<string>;
  /** Resolves authenticated attachment URLs to browser-displayable object URLs. */
  resolveImageSrc?: (src: string) => Promise<string>;
  onEditorReady?: (editor: Editor) => void;
  readOnly?: boolean;
  markdownView?: boolean;
  /** Stable owning-note identity; protects a reused editor from stale content. */
  documentId?: string;
}) {
  const [contextMenu, setContextMenu] = useState<EditorContextMenu>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onSaveRef = useRef(onSave);
  const documentIdRef = useRef(documentId);
  onSaveRef.current = onSave;
  const normalizedContent = useMemo(() => normalizeMathContent(content), [content]);
  const editor = useEditor({
    extensions: [
      // Link and Underline are configured explicitly below; disable the
      // StarterKit variants to avoid registering the same Tiptap extension twice.
      StarterKit.configure({ codeBlock: false, link: false, underline: false }),
      YgdriaCodeBlock,
      Underline,
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Link,
      AuthenticatedImage,
      MathInline,
      MathBlock,
      ClipboardShortcuts,
      Indent,
      NoteReference,
      Redacted,
      SearchReplace,
    ],
    content: normalizedContent as any,
    editable: !readOnly,
    onUpdate: ({ editor }: { editor: Editor }) => {
      // View-mode transactions (including plugin and selection updates) must
      // never persist content. Otherwise a stale editor can overwrite the
      // note selected after it.
      if (editor.isEditable) onSaveRef.current?.(editor.getJSON() as NoteContent);
    },
    editorProps: {
      attributes: { class: "ygdria-document ygdria-editor", spellcheck: "false" },
      transformPastedHTML: normalizePastedHtml,
      handlePaste: (view, event) => {
        // Browsers expose screenshots and copied files as ClipboardItems, not
        // HTML. Tiptap does not upload those files by itself, so handle them
        // before the default parser silently drops them.
        const files = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (files.length === 0 || !onUploadImage) return false;

        const insertionStart = view.state.selection.from;
        void (async () => {
          let position = insertionStart;
          for (const file of files) {
            try {
              const src = await onUploadImage(file);
              // Content can change while the attachment uploads. Clamp the
              // saved position rather than using a possibly stale selection.
              position = Math.min(position, view.state.doc.content.size);
              const image = view.state.schema.nodes.image?.create({ src });
              if (!image) return;
              view.dispatch(view.state.tr.insert(position, image));
              position += image.nodeSize;
            } catch {
              // Leave the existing document untouched if an upload fails.
            }
          }
        })();
        return true;
      },
      handleKeyDown: (view, event) => {
        // Keep Delete scoped to the editor: a selected text/node range is
        // removed here, while a collapsed cursor keeps ProseMirror's normal
        // forward-delete behaviour.
        if (event.key !== "Delete" || view.state.selection.empty) return false;
        view.dispatch(view.state.tr.deleteSelection());
        return true;
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;
        const redacted = target?.closest<HTMLElement>("[data-ygdria-redacted]");
        const wasRevealed = redacted?.classList.contains("is-revealed");
        editor?.view.dom.querySelectorAll("[data-ygdria-redacted].is-revealed").forEach((element) => element.classList.remove("is-revealed"));
        if (redacted && !wasRevealed) redacted.classList.add("is-revealed");
        return false;
      },
      handleDOMEvents: {
        contextmenu: (view, event) => {
          if (!view.editable) return false;
          event.preventDefault();
          window.dispatchEvent(new Event("ygdria:editor-context-menu-open"));
          const mouseEvent = event as MouseEvent;
          const hasSelection = !view.state.selection.empty;
          setContextMenu({
            x: Math.max(8, Math.min(mouseEvent.clientX, window.innerWidth - 316)),
            y: Math.max(8, Math.min(mouseEvent.clientY, window.innerHeight - 230)),
            hasSelection,
          });
          return true;
        },
      },
    },
  });
  // `useEditor` consumes `editable` only at creation time. Switching modes
  // must keep this instance and its node views intact.
  useEffect(() => {
    editor?.setEditable(!readOnly);
    if (readOnly) setContextMenu(null);
  }, [editor, readOnly]);
  useEffect(() => {
    if (!editor) return;
    const hideOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof globalThis.Node) || editor.view.dom.contains(event.target)) return;
      editor.view.dom.querySelectorAll("[data-ygdria-redacted].is-revealed").forEach((element) => element.classList.remove("is-revealed"));
    };
    document.addEventListener("pointerdown", hideOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", hideOnOutsidePointer);
  }, [editor]);
  useEffect(() => {
    if (!editor || editor.isDestroyed || documentIdRef.current === documentId) return;
    documentIdRef.current = documentId;
    // `useEditor` treats `content` as initial state. Synchronize explicitly
    // when an existing editor is retargeted, without emitting a save.
    editor.commands.setContent(normalizedContent as any, { emitUpdate: false });
  }, [normalizedContent, documentId, editor]);
  useEffect(() => () => editor?.destroy(), [editor]);
  useEffect(() => {
    if (!editor || !resolveImageSrc) return;
    const objectUrls = new Set<string>();
    let disposed = false;
    const resolveImages = () => {
      editor.view.dom.querySelectorAll("img").forEach((image) => {
        const element = image as HTMLImageElement;
        const source = element.dataset.ygdriaSource ?? element.getAttribute("src");
        if (!source || element.dataset.ygdriaResolving === "true") return;
        element.dataset.ygdriaSource = source;
        element.dataset.ygdriaResolving = "true";
        void resolveImageSrc(source).then((resolved) => {
          if (disposed) return;
          if (resolved.startsWith("blob:")) objectUrls.add(resolved);
          element.src = resolved;
        }).catch(() => {
          // Keep the stored URL in place if its authenticated fetch fails.
        }).finally(() => { delete element.dataset.ygdriaResolving; });
      });
    };
    resolveImages();
    const observer = new MutationObserver(resolveImages);
    observer.observe(editor.view.dom, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [editor, resolveImageSrc]);
  useEffect(() => {
    if (editor) onEditorReady?.(editor);
  }, [editor]);

  // Open the find/replace bottom bar with Ctrl/Cmd+F, overriding the browser's
  // native page search while the note body is focused.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const closeSearch = () => {
    setSearchOpen(false);
    if (editor && !editor.isDestroyed && !markdownView) editor.commands.clearSearch();
  };
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && setContextMenu(null);
    const closeOnPointerDown = () => setContextMenu(null);
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", closeOnPointerDown);
    };
  }, []);

  // ── Markdown view state ──
  const [markdownText, setMarkdownText] = useState("");
  const markdownTextRef = useRef("");
  const originalMarkdownRef = useRef("");
  const [markdownReady, setMarkdownReady] = useState(false);
  const markdownInitializedRef = useRef(false);

  const commitMarkdown = () => {
    if (!markdownInitializedRef.current) return;
    if (markdownTextRef.current === originalMarkdownRef.current) return;
    const { document } = markdownToTiptap(markdownTextRef.current);
    onSaveRef.current?.(document);
    originalMarkdownRef.current = markdownTextRef.current;
    if (editor && !editor.isDestroyed) {
      // The explicit save above uses the normal auto-save path. Do not emit a
      // second update for the same Markdown edit.
      editor.commands.setContent(document as any, { emitUpdate: false });
    }
  };

  // Convert the editor content when entering Markdown view, and commit once
  // when returning to rich text. Intermediate textarea states are never saved.
  useEffect(() => {
    if (markdownView && !markdownInitializedRef.current && editor) {
      const json = editor.getJSON() as NoteContent;
      const { markdown } = tiptapToMarkdown(json);
      setMarkdownText(markdown);
      markdownTextRef.current = markdown;
      originalMarkdownRef.current = markdown;
      setMarkdownReady(true);
      markdownInitializedRef.current = true;
    } else if (!markdownView && markdownInitializedRef.current) {
      commitMarkdown();
      markdownInitializedRef.current = false;
      setMarkdownReady(false);
    }
  }, [markdownView, editor]);

  const handleMarkdownChange = (nextMarkdown: string) => {
    setMarkdownText(nextMarkdown);
    markdownTextRef.current = nextMarkdown;
  };

  // Switching notes or leaving edit mode unmounts the editor directly. Commit
  // pending Markdown once in that case as well, instead of losing the draft.
  useEffect(() => () => {
    if (markdownInitializedRef.current) commitMarkdown();
  }, []);

  const labels =
    locale === "zh-CN"
      ? {
          cut: "剪切",
          copy: "复制",
          markdown: "复制为 Markdown",
          paste: "粘贴",
          plain: "以纯文本粘贴",
        }
      : {
          cut: "Cut",
          copy: "Copy",
          markdown: "Copy as Markdown",
          paste: "Paste",
          plain: "Paste as plain text",
        };
  const closeMenu = () => setContextMenu(null);
  const selectedMarkdown = () => {
    if (!editor || editor.state.selection.empty) return "";
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.cut(from, to).toJSON() as NoteContent;
    return tiptapToMarkdown(selected).markdown;
  };
  const clipboardCommand = (command: "cut" | "copy") => {
    editor?.commands.focus();
    document.execCommand(command);
    closeMenu();
  };
  const paste = async (plain: boolean) => {
    if (!editor) return;
    try {
      if (!plain && navigator.clipboard?.read) {
        const [item] = await navigator.clipboard.read();
        if (item?.types.includes("text/html")) {
          const html = await (await item.getType("text/html")).text();
          editor.commands.insertContent(normalizePastedHtml(html));
          closeMenu();
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      editor.commands.insertContent(text);
    } catch {
      // Browsers may reject clipboard reads outside a secure, permitted context.
      // The native keyboard shortcut remains available in that case.
    }
    closeMenu();
  };

  return (
    <>
      {markdownView ? (
        <div className="ygdria-markdown-view">
          <textarea
            ref={textareaRef}
            className="ygdria-markdown-textarea"
            value={markdownText}
            onChange={(e) => handleMarkdownChange(e.target.value)}
            placeholder={locale === "zh-CN" ? "在此输入 Markdown 源码..." : "Enter Markdown source here..."}
            disabled={!markdownReady}
            spellCheck={false}
          />
        </div>
      ) : (
        <EditorContent editor={editor} />
      )}
      {searchOpen && (
        <SearchReplaceBar
          locale={locale}
          markdownView={markdownView}
          editor={editor}
          textarea={textareaRef.current}
          markdownText={markdownText}
          onMarkdownChange={handleMarkdownChange}
          onClose={closeSearch}
          readOnly={readOnly}
        />
      )}
      {!readOnly && contextMenu && (
        <div
          className="action-menu editor-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <EditorMenuButton
            icon="✂"
            label={labels.cut}
            shortcut="Ctrl+X"
            disabled={!contextMenu.hasSelection}
            onClick={() => clipboardCommand("cut")}
          />
          <EditorMenuButton
            icon="⧉"
            label={labels.copy}
            shortcut="Ctrl+C"
            disabled={!contextMenu.hasSelection}
            onClick={() => clipboardCommand("copy")}
          />
          <EditorMenuButton
            icon="▧"
            label={labels.markdown}
            disabled={!contextMenu.hasSelection}
            onClick={async () => {
              const markdown = selectedMarkdown();
              if (markdown) await navigator.clipboard?.writeText(markdown);
              closeMenu();
            }}
          />
          <div className="editor-context-separator" />
          <EditorMenuButton
            icon="▣"
            label={labels.paste}
            shortcut="Ctrl+V"
            onClick={() => void paste(false)}
          />
          <EditorMenuButton
            icon="▣"
            label={labels.plain}
            shortcut="Ctrl+Shift+V"
            onClick={() => void paste(true)}
          />
        </div>
      )}
    </>
  );
}

function EditorMenuButton({
  icon,
  label,
  shortcut,
  disabled = false,
  onClick,
}: {
  icon: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      <span className="editor-context-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}
