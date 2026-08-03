import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  BookOpen,
  ChevronDown,
  ClipboardPaste,
  Code,
  Edit3,
  EyeOff,
  Highlighter,
  Image,
  IndentIncrease,
  IndentDecrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  MoreHorizontal,
  Palette,
  Paintbrush,
  Quote,
  Redo,
  SquareCode,
  Strikethrough,
  Table,
  Type,
  Underline,
  Undo,
} from "lucide-react";

type Locale = "zh-CN" | "en";
type DropdownKey = "paragraph" | "alignment" | "decoration" | null;
type CopiedFormat = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  color: string;
  highlight: string;
  headingLevel?: number;
  align: "left" | "center" | "right" | "justify";
  block: "paragraph" | "bulletList" | "orderedList" | "taskList" | "blockquote" | "codeBlock";
  persistent?: boolean;
};

// Palette now references design tokens defined in the web app's tokens.css
// (see --editor-text-* / --editor-highlight-*). This keeps the swatch colors
// centralized and themeable instead of hardcoding hex here.
const DEFAULT_TEXT_COLOR = "var(--editor-text-default)";
const DEFAULT_HIGHLIGHT_COLOR = "var(--editor-highlight-default)";
const TEXT_COLOR_PALETTE = [
  "var(--editor-text-1)", "var(--editor-text-2)", "var(--editor-text-3)", "var(--editor-text-4)", "var(--editor-text-5)",
  "var(--editor-text-6)", "var(--editor-text-7)", "var(--editor-text-8)", "var(--editor-text-9)", "var(--editor-text-10)",
];
const HIGHLIGHT_COLOR_PALETTE = [
  "var(--editor-highlight-1)", "var(--editor-highlight-2)", "var(--editor-highlight-3)", "var(--editor-highlight-4)", "var(--editor-highlight-5)",
  "var(--editor-highlight-6)", "var(--editor-highlight-7)", "var(--editor-highlight-8)", "var(--editor-highlight-9)", "var(--editor-highlight-10)",
];

// Resolve a `var(--token)` color to its computed value (used for <input type="color">,
// which only accepts literal colors). Non-var colors pass through unchanged.
function resolveColor(value: string): string {
  if (!value.startsWith("var(")) return value;
  if (typeof document === "undefined" || !document.documentElement) return value;
  const name = value.slice(4, -1).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return resolved || value;
}

const MODE_LABELS = {
  "zh-CN": { read: "只读", edit: "编辑" },
  en: { read: "Read-only", edit: "Edit" },
};

const EMPTY_EDITOR_STATE = {
  isBold: false,
  isItalic: false,
  isUnderline: false,
  isStrike: false,
  isCode: false,
  isRedacted: false,
  isBlockquote: false,
  isCodeBlock: false,
  isBulletList: false,
  isOrderedList: false,
  isTaskList: false,
  isLink: false,
  align: "left",
  color: "",
  highlight: "",
  headingLevel: undefined as number | undefined,
  isParagraph: true,
  canUndo: false,
  canRedo: false,
};

export function EditorToolbar({
  editor,
  locale,
  onUploadImage,
  editing = true,
  onToggleEditing,
  onImportMarkdown,
}: {
  editor?: Editor | null;
  locale: Locale;
  onUploadImage?: (file: File) => Promise<string>;
  editing?: boolean;
  onToggleEditing?: () => void;
  onImportMarkdown?: () => void;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const modeLabels = MODE_LABELS[locale];
  const [overflowLevel, setOverflowLevel] = useState(0);

  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      setOverflowLevel(width < 720 ? 2 : width < 980 ? 1 : 0);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={toolbarRef} className={`editor-toolbar overflow-level-${overflowLevel}`} role="toolbar" aria-label="editor-toolbar">
      {/* Formatting tools – only when editing with an editor */}
      {editing && editor && (
        <EditorTools editor={editor} locale={locale} onUploadImage={onUploadImage} overflowLevel={overflowLevel} />
      )}

      {/* Markdown import */}
      {editing && onImportMarkdown && (
        <button
          type="button"
          className="editor-toolbar-md-btn"
          title={TOOLBAR_LABELS[locale].importMarkdown}
          aria-label={TOOLBAR_LABELS[locale].importMarkdown}
          onClick={onImportMarkdown}
        >
          <ClipboardPaste size={16} />
        </button>
      )}
      {/* Mode toggle – always visible, right-aligned */}
      {onToggleEditing && (
        <div className="mode-toggle">
          <button
            type="button"
            className={`mode-btn mode-read${!editing ? " is-active" : ""}`}
            onClick={editing ? onToggleEditing : undefined}
            disabled={!editing}
            title={modeLabels.read}
          >
            <BookOpen size={14} /> {modeLabels.read}
          </button>
          <button
            type="button"
            className={`mode-btn mode-edit${editing ? " is-active" : ""}`}
            onClick={!editing ? onToggleEditing : undefined}
            disabled={editing}
            title={modeLabels.edit}
          >
            <Edit3 size={14} /> {modeLabels.edit}
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Inner component that uses useEditorState (requires editor) ─── */

function EditorTools({
  editor,
  locale,
  onUploadImage,
  overflowLevel,
}: {
  editor: Editor;
  locale: Locale;
  onUploadImage?: (file: File) => Promise<string>;
  overflowLevel: number;
}) {
  const [openDropdown, setOpenDropdown] = useState<DropdownKey>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkPopoverStyle, setLinkPopoverStyle] = useState<React.CSSProperties>({});
  const [formatPainter, setFormatPainter] = useState<CopiedFormat | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [morePanelStyle, setMorePanelStyle] = useState<React.CSSProperties>({});
  const linkInputRef = useRef<HTMLInputElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const savedSelectionPos = useRef<number | null>(null);
  const applyingFormatPainter = useRef(false);

  const state = useEditorState({
    editor,
    selector: (ctx) => {
      // Tiptap clears this reference while the previous note's editor is
      // unmounting. The toolbar can still receive one final state update.
      const currentEditor = ctx.editor;
      if (!currentEditor || currentEditor.isDestroyed) return EMPTY_EDITOR_STATE;
      const textStyle = currentEditor.getAttributes("textStyle") as { color?: string; fontSize?: string };
      const highlight = currentEditor.getAttributes("highlight") as { color?: string };
      const paragraphAlign = (currentEditor.getAttributes("paragraph") as { textAlign?: string }).textAlign;
      const headingAlign = (currentEditor.getAttributes("heading") as { textAlign?: string }).textAlign;
      return {
        isBold: currentEditor.isActive("bold"),
        isItalic: currentEditor.isActive("italic"),
        isUnderline: currentEditor.isActive("underline"),
        isStrike: currentEditor.isActive("strike"),
        isCode: currentEditor.isActive("code"),
        isRedacted: currentEditor.isActive("redacted"),
        isBlockquote: currentEditor.isActive("blockquote"),
        isCodeBlock: currentEditor.isActive("codeBlock"),
        isBulletList: currentEditor.isActive("bulletList"),
        isOrderedList: currentEditor.isActive("orderedList"),
        isTaskList: currentEditor.isActive("taskList"),
        isLink: currentEditor.isActive("link"),
        align: paragraphAlign || headingAlign || "left",
        color: textStyle.color || "",
        highlight: highlight.color || "",
        headingLevel: (currentEditor.getAttributes("heading") as { level?: number }).level,
        isParagraph: currentEditor.isActive("paragraph"),
        canUndo: currentEditor.can().undo(),
        canRedo: currentEditor.can().redo(),
      };
    },
  });

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if ((target as Element)?.closest?.(".editor-toolbar")) return;
      if ((target as Element)?.closest?.(".editor-toolbar-dropdown-panel")) return;
      if ((target as Element)?.closest?.(".editor-toolbar-overflow-panel")) return;
      if ((target as Element)?.closest?.(".editor-toolbar-link-popover")) return;
      setOpenDropdown(null);
      setShowLinkInput(false);
      setShowMore(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenDropdown(null);
        setShowLinkInput(false);
        setFormatPainter(null);
        setShowMore(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (overflowLevel === 0) setShowMore(false);
  }, [overflowLevel]);

  useEffect(() => {
    if (!formatPainter) return;
    editor.view.dom.classList.add("format-painter-active");
    let selectionStartedInEditor = false;
    const applyToTarget = () => {
      if (applyingFormatPainter.current) return;
      applyingFormatPainter.current = true;
      try {
        const selection = editor.state.selection;
        // A click leaves a collapsed cursor. Word's format painter applies
        // inline formatting to the clicked word and paragraph formatting to
        // its containing block; dragging keeps the user's exact range.
        const ranges = selection.ranges
          .map((range) => ({ from: Math.min(range.$from.pos, range.$to.pos), to: Math.max(range.$from.pos, range.$to.pos) }))
          .flatMap((range) => {
            if (range.from !== range.to) return [range];
            const $pos = editor.state.doc.resolve(range.from);
            const text = $pos.parent.textContent;
            const offset = $pos.parentOffset;
            const isWord = (character: string) => /[\p{L}\p{N}_]/u.test(character);
            let start = offset;
            let end = offset;
            while (start > 0 && isWord(text[start - 1] ?? "")) start -= 1;
            while (end < text.length && isWord(text[end] ?? "")) end += 1;
            const blockStart = $pos.start();
            return [{ from: blockStart + (start === end ? 0 : start), to: blockStart + (start === end ? text.length : end) }];
          });
        if (!ranges.length) return;
        for (const range of ranges) {
          const chain = editor.chain().focus().setTextSelection(range).unsetAllMarks();
          if (formatPainter.bold) chain.setBold();
          if (formatPainter.italic) chain.setItalic();
          if (formatPainter.underline) chain.setUnderline();
          if (formatPainter.strike) chain.setStrike();
          if (formatPainter.code) chain.setCode();
          if (formatPainter.color) chain.setColor(formatPainter.color);
          if (formatPainter.highlight) chain.setHighlight({ color: formatPainter.highlight });
          chain.clearNodes().setParagraph();
          if (formatPainter.headingLevel) chain.setHeading({ level: formatPainter.headingLevel as 1 | 2 | 3 | 4 | 5 | 6 });
          if (formatPainter.block === "bulletList") chain.toggleBulletList();
          if (formatPainter.block === "orderedList") chain.toggleOrderedList();
          if (formatPainter.block === "taskList") chain.toggleTaskList();
          if (formatPainter.block === "blockquote") chain.toggleBlockquote();
          if (formatPainter.block === "codeBlock") chain.toggleCodeBlock();
          chain.setTextAlign(formatPainter.align).run();
        }
      } finally {
        if (!formatPainter.persistent) setFormatPainter(null);
        applyingFormatPainter.current = false;
      }
    };
    const onPointerDown = () => {
      selectionStartedInEditor = true;
    };
    const onPointerUp = () => {
      if (!selectionStartedInEditor) return;
      selectionStartedInEditor = false;
      // The browser commits a backwards drag selection after pointerup in some
      // engines. Two frames guarantees that ProseMirror has the final range.
      requestAnimationFrame(() => requestAnimationFrame(applyToTarget));
    };
    editor.view.dom.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      editor.view.dom.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      editor.view.dom.classList.remove("format-painter-active");
    };
  }, [editor, formatPainter]);

  useLayoutEffect(() => {
    if (showLinkInput && linkButtonRef.current) {
      const rect = linkButtonRef.current.getBoundingClientRect();
      setLinkPopoverStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 320)),
      });
      requestAnimationFrame(() => linkInputRef.current?.focus());
    }
  }, [showLinkInput]);

  useLayoutEffect(() => {
    if (!showMore || !moreButtonRef.current) return;
    const rect = moreButtonRef.current.getBoundingClientRect();
    setMorePanelStyle({
      position: "fixed",
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 244)),
    });
  }, [showMore]);

  const labels = TOOLBAR_LABELS[locale];

  const toggleDropdown = (key: DropdownKey) => {
    setOpenDropdown((current) => (current === key ? null : key));
  };

  const run = (command: () => boolean | void) => {
    command();
    setOpenDropdown(null);
    setShowMore(false);
  };

  const toggleCodeBlock = () => {
    if (editor.isActive("codeBlock")) return editor.chain().focus().toggleCodeBlock().run();
    return editor.chain().focus().setCodeBlock({ language: "auto" }).run();
  };

  const paragraphLabel = state.headingLevel
    ? labels.headingLevel(state.headingLevel)
    : labels.paragraph;

  return (
    <>
      {/* Paragraph / Heading dropdown */}
      <ToolbarDropdown
        active={openDropdown === "paragraph"}
        narrow
        label={paragraphLabel}
        icon={null}
        onToggle={() => toggleDropdown("paragraph")}
      >
        <DropdownItem
          active={state.isParagraph}
          label={labels.paragraph}
          onClick={() => run(() => editor.chain().focus().setParagraph().run())}
        />
        {([1, 2, 3, 4, 5, 6] as const).map((level) => (
          <DropdownItem
            key={level}
            active={state.headingLevel === level}
            label={labels.headingLevel(level)}
            onClick={() => run(() => editor.chain().focus().toggleHeading({ level }).run())}
          />
        ))}
      </ToolbarDropdown>

      <ToolbarSeparator />

      {/* Group 1 – Text style: B I U S Color Highlight */}
      <ToolbarGroup>
        <ToolbarButton
          active={state.isBold}
          label={labels.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={Boolean(state.headingLevel)}
          icon={<Bold size={16} />}
        />
        <ToolbarButton
          active={state.isItalic}
          label={labels.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          icon={<Italic size={16} />}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* Group 2 – Paragraph structure: List Quote CodeBlock */}
      <ToolbarGroup>
        <ToolbarButton
          active={state.isBulletList}
          label={labels.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          icon={<List size={16} />}
        />
        <ToolbarButton
          active={state.isOrderedList}
          label={labels.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          icon={<ListOrdered size={16} />}
        />
        <ToolbarButton
          active={state.isTaskList}
          label={labels.taskList}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          icon={<ListChecks size={16} />}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* Group 3 – Common insert tools */}
      <ToolbarGroup>
        <ToolbarButton
          active={false}
          label={labels.image}
          onClick={() => {
            savedSelectionPos.current = editor.state.selection.from;
            imageInputRef.current?.click();
          }}
          icon={<Image size={16} />}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              const pos = savedSelectionPos.current ?? editor.state.selection.from;
              if (onUploadImage) {
                const url = await onUploadImage(file);
                editor.chain().focus().setTextSelection(pos).setImage({ src: url }).run();
              } else {
                const reader = new FileReader();
                reader.onload = () => {
                  const src = reader.result as string;
                  editor.chain().focus().setTextSelection(pos).setImage({ src }).run();
                };
                reader.readAsDataURL(file);
              }
            } catch {
              // upload failed – silently ignore
            }
            event.target.value = "";
          }}
        />
        <ToolbarButton
          active={state.isLink}
          label={labels.link}
          onClick={() => {
            if (state.isLink) {
              editor.chain().focus().unsetLink().run();
            } else {
              setLinkUrl("");
              setShowLinkInput(true);
            }
          }}
          icon={<Link size={16} />}
          buttonRef={linkButtonRef}
        />
      </ToolbarGroup>

      <ToolbarSeparator />

      {/* Secondary tools remain visible in a wide document pane and move to
          the overflow panel only when the pane itself becomes narrow. */}
      <div className="editor-toolbar-secondary">
        <div className="editor-toolbar-secondary-primary"><ToolbarGroup>
          <ToolbarDropdown active={openDropdown === "decoration"} compact label={labels.textDecoration} icon={<Type size={16} />} onToggle={() => toggleDropdown("decoration")}><ToolbarGroup>
            <ToolbarButton active={state.isUnderline} label={labels.underline} icon={<Underline size={16} />} onClick={() => run(() => editor.chain().focus().toggleUnderline().run())} />
            <ToolbarButton active={state.isStrike} label={labels.strikethrough} icon={<Strikethrough size={16} />} onClick={() => run(() => editor.chain().focus().toggleStrike().run())} />
            <ToolbarButton active={state.isRedacted} label={labels.redacted} icon={<EyeOff size={16} />} onClick={() => run(() => (editor.chain().focus() as any).toggleRedacted().run())} />
          </ToolbarGroup></ToolbarDropdown>
          <ColorButton type="text" color={state.color || DEFAULT_TEXT_COLOR} label={labels.textColor} locale={locale} onChange={(color) => editor.chain().focus().setColor(color).run()} onReset={() => editor.chain().focus().unsetColor().run()} />
          <ColorButton type="highlight" color={state.highlight || DEFAULT_HIGHLIGHT_COLOR} label={labels.highlight} locale={locale} onChange={(color) => editor.chain().focus().setHighlight({ color }).run()} onReset={() => editor.chain().focus().unsetHighlight().run()} />
          <ToolbarButton active={Boolean(formatPainter)} label={labels.formatPainter} onClick={() => setFormatPainter((current) => current ? null : { bold: state.isBold, italic: state.isItalic, underline: state.isUnderline, strike: state.isStrike, code: state.isCode, color: state.color, highlight: state.highlight, headingLevel: state.headingLevel, align: state.align as CopiedFormat["align"], block: state.isBulletList ? "bulletList" : state.isOrderedList ? "orderedList" : state.isTaskList ? "taskList" : state.isBlockquote ? "blockquote" : state.isCodeBlock ? "codeBlock" : "paragraph" })} onDoubleClick={() => setFormatPainter({ bold: state.isBold, italic: state.isItalic, underline: state.isUnderline, strike: state.isStrike, code: state.isCode, color: state.color, highlight: state.highlight, headingLevel: state.headingLevel, align: state.align as CopiedFormat["align"], block: state.isBulletList ? "bulletList" : state.isOrderedList ? "orderedList" : state.isTaskList ? "taskList" : state.isBlockquote ? "blockquote" : state.isCodeBlock ? "codeBlock" : "paragraph", persistent: true })} icon={<Paintbrush size={16} />} />
        </ToolbarGroup><ToolbarSeparator /></div>
        <div className="editor-toolbar-secondary-overflow"><ToolbarGroup>
          <ToolbarButton active={state.isBlockquote} label={labels.quote} onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())} icon={<Quote size={16} />} />
          <ToolbarButton active={state.isCodeBlock} label={labels.codeBlock} onClick={() => run(toggleCodeBlock)} icon={<SquareCode size={16} />} />
          <ToolbarButton active={false} label={labels.table} onClick={() => run(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())} icon={<Table size={16} />} />
          <ToolbarButton active={state.isCode} label={labels.inlineCode} onClick={() => run(() => editor.chain().focus().toggleCode().run())} icon={<Code size={16} />} />
          <ToolbarDropdown active={openDropdown === "alignment"} compact label={labels.alignment} icon={<AlignJustify size={16} />} onToggle={() => toggleDropdown("alignment")}><ToolbarGroup>
            <ToolbarButton active={state.align === "left"} label={labels.alignLeft} icon={<AlignLeft size={16} />} onClick={() => run(() => editor.chain().focus().setTextAlign("left").run())} />
            <ToolbarButton active={state.align === "center"} label={labels.alignCenter} icon={<AlignCenter size={16} />} onClick={() => run(() => editor.chain().focus().setTextAlign("center").run())} />
            <ToolbarButton active={state.align === "right"} label={labels.alignRight} icon={<AlignRight size={16} />} onClick={() => run(() => editor.chain().focus().setTextAlign("right").run())} />
          </ToolbarGroup></ToolbarDropdown>
          <ToolbarButton active={false} label={labels.indent} onClick={() => run(() => (editor.chain().focus() as any).indent().run())} icon={<IndentIncrease size={16} />} />
          <ToolbarButton active={false} label={labels.outdent} onClick={() => run(() => (editor.chain().focus() as any).outdent().run())} icon={<IndentDecrease size={16} />} />
        </ToolbarGroup><ToolbarSeparator /></div>
      </div>

      {/* Group 4 – History */}
      <ToolbarGroup>
        <ToolbarButton
          active={false}
          label={labels.undo}
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!state.canUndo}
          icon={<Undo size={16} />}
        />
        <ToolbarButton
          active={false}
          label={labels.redo}
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!state.canRedo}
          icon={<Redo size={16} />}
        />
      </ToolbarGroup>
      <div className="editor-toolbar-more-trigger"><ToolbarButton active={showMore} label={labels.moreTools} buttonRef={moreButtonRef} onClick={() => setShowMore((open) => !open)} icon={<MoreHorizontal size={17} />} /></div>

      {showMore && createPortal(
        <div className="editor-toolbar-overflow-panel" role="menu" style={morePanelStyle} onMouseDown={(event) => event.stopPropagation()}>
          {overflowLevel === 2 && <ToolbarGroup>
            <ToolbarDropdown active={openDropdown === "decoration"} compact label={labels.textDecoration} icon={<Type size={16} />} onToggle={() => toggleDropdown("decoration")}>
              <ToolbarGroup>
                <ToolbarButton active={state.isUnderline} label={labels.underline} icon={<Underline size={16} />} onClick={() => run(() => editor.chain().focus().toggleUnderline().run())} />
                <ToolbarButton active={state.isStrike} label={labels.strikethrough} icon={<Strikethrough size={16} />} onClick={() => run(() => editor.chain().focus().toggleStrike().run())} />
                <ToolbarButton active={state.isRedacted} label={labels.redacted} icon={<EyeOff size={16} />} onClick={() => run(() => (editor.chain().focus() as any).toggleRedacted().run())} />
              </ToolbarGroup>
            </ToolbarDropdown>
            <ColorButton type="text" color={state.color || DEFAULT_TEXT_COLOR} label={labels.textColor} locale={locale} onChange={(color) => editor.chain().focus().setColor(color).run()} onReset={() => editor.chain().focus().unsetColor().run()} />
            <ColorButton type="highlight" color={state.highlight || DEFAULT_HIGHLIGHT_COLOR} label={labels.highlight} locale={locale} onChange={(color) => editor.chain().focus().setHighlight({ color }).run()} onReset={() => editor.chain().focus().unsetHighlight().run()} />
            <ToolbarButton active={Boolean(formatPainter)} label={labels.formatPainter} onClick={() => setFormatPainter((current) => current ? null : { bold: state.isBold, italic: state.isItalic, underline: state.isUnderline, strike: state.isStrike, code: state.isCode, color: state.color, highlight: state.highlight, headingLevel: state.headingLevel, align: state.align as CopiedFormat["align"], block: state.isBulletList ? "bulletList" : state.isOrderedList ? "orderedList" : state.isTaskList ? "taskList" : state.isBlockquote ? "blockquote" : state.isCodeBlock ? "codeBlock" : "paragraph" })} onDoubleClick={() => setFormatPainter({ bold: state.isBold, italic: state.isItalic, underline: state.isUnderline, strike: state.isStrike, code: state.isCode, color: state.color, highlight: state.highlight, headingLevel: state.headingLevel, align: state.align as CopiedFormat["align"], block: state.isBulletList ? "bulletList" : state.isOrderedList ? "orderedList" : state.isTaskList ? "taskList" : state.isBlockquote ? "blockquote" : state.isCodeBlock ? "codeBlock" : "paragraph", persistent: true })} icon={<Paintbrush size={16} />} />
          </ToolbarGroup>}
          {overflowLevel > 0 && <ToolbarGroup>
            <ToolbarButton active={state.isBlockquote} label={labels.quote} onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())} icon={<Quote size={16} />} />
            <ToolbarButton active={state.isCodeBlock} label={labels.codeBlock} onClick={() => run(toggleCodeBlock)} icon={<SquareCode size={16} />} />
          </ToolbarGroup>}
          {overflowLevel > 0 && <ToolbarGroup>
            <ToolbarButton active={false} label={labels.table} onClick={() => run(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())} icon={<Table size={16} />} />
            <ToolbarButton active={state.isCode} label={labels.inlineCode} onClick={() => run(() => editor.chain().focus().toggleCode().run())} icon={<Code size={16} />} />
          </ToolbarGroup>}
          {overflowLevel > 0 && <ToolbarGroup>
            <ToolbarDropdown active={openDropdown === "alignment"} compact label={labels.alignment} icon={<AlignJustify size={16} />} onToggle={() => toggleDropdown("alignment")}>
              <ToolbarGroup>
                <ToolbarButton active={state.align === "left"} label={labels.alignLeft} icon={<AlignLeft size={16} />} onClick={() => run(() => editor.chain().focus().setTextAlign("left").run())} />
                <ToolbarButton active={state.align === "center"} label={labels.alignCenter} icon={<AlignCenter size={16} />} onClick={() => run(() => editor.chain().focus().setTextAlign("center").run())} />
                <ToolbarButton active={state.align === "right"} label={labels.alignRight} icon={<AlignRight size={16} />} onClick={() => run(() => editor.chain().focus().setTextAlign("right").run())} />
              </ToolbarGroup>
            </ToolbarDropdown>
            <ToolbarButton active={false} label={labels.indent} onClick={() => run(() => (editor.chain().focus() as any).indent().run())} icon={<IndentIncrease size={16} />} />
            <ToolbarButton active={false} label={labels.outdent} onClick={() => run(() => (editor.chain().focus() as any).outdent().run())} icon={<IndentDecrease size={16} />} />
          </ToolbarGroup>}
        </div>,
        document.body,
      )}

      {showLinkInput && createPortal(
        <div className="editor-toolbar-link-popover" role="dialog" aria-label={labels.link} style={linkPopoverStyle}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (linkUrl) {
                editor.chain().focus().setLink({ href: linkUrl }).run();
              }
              setShowLinkInput(false);
            }}
          >
            <input
              ref={linkInputRef}
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder={labels.linkUrl}
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowLinkInput(false);
              }}
            />
            <button type="submit" disabled={!linkUrl}>
              ✓
            </button>
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}

/* ─── Shared sub-components ─── */

function ToolbarGroup({ children }: { children: React.ReactNode }) {
  return <div className="editor-toolbar-group">{children}</div>;
}

function ToolbarSeparator() {
  return <div className="editor-toolbar-separator" aria-hidden="true" />;
}

function ToolbarButton({
  active,
  label,
  icon,
  onClick,
  onDoubleClick,
  disabled = false,
  buttonRef,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  onDoubleClick?: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={active ? "is-active" : undefined}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {icon}
    </button>
  );
}

function ToolbarDropdown({
  active,
  label,
  icon,
  compact = false,
  narrow = false,
  onToggle,
  children,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  compact?: boolean;
  narrow?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (active && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPanelStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 170)),
        minWidth: compact ? 0 : Math.max(150, rect.width),
      });
    }
  }, [active, compact]);

  return (
    <div className={`editor-toolbar-dropdown${compact ? " is-compact" : ""}${narrow ? " is-narrow" : ""}${active ? " is-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={active ? "is-active" : undefined}
        title={label}
        aria-label={label}
        aria-expanded={active}
        onClick={onToggle}
      >
        {icon}
        {!compact && <span className="editor-toolbar-dropdown-label">{label}</span>}
        <ChevronDown size={14} />
      </button>
      {active && createPortal(
        <div
          className={`editor-toolbar-dropdown-panel${compact ? " is-compact-options" : ""}`}
          role="menu"
          style={panelStyle}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}

function DropdownItem({
  active,
  label,
  icon,
  onClick,
  disabled = false,
}: {
  active: boolean;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={active ? "is-active" : undefined}
      title={label}
      aria-label={label}
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ?? label}
    </button>
  );
}

function ColorButton({
  type,
  color,
  label,
  locale,
  onChange,
  onReset,
}: {
  type: "text" | "highlight";
  color: string;
  label: string;
  locale: Locale;
  onChange: (color: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const icon = type === "text" ? <Palette size={16} /> : <Highlighter size={16} />;
  const colorLabels = TOOLBAR_LABELS[locale];
  const palette = type === "text" ? TEXT_COLOR_PALETTE : HIGHLIGHT_COLOR_PALETTE;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPanelStyle({
      position: "fixed",
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.right - 250, window.innerWidth - 258)),
    });
  }, [open]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest(".editor-toolbar-color")) return;
      if (target.closest(".editor-toolbar-color-panel")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div className="editor-toolbar-color" title={label}>
      <button type="button" className="editor-toolbar-color-icon" aria-label={label} onClick={() => onChange(color)}>
        {icon}
        <span className="editor-toolbar-color-strip" style={{ backgroundColor: color }} />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="editor-toolbar-color-dropdown"
        aria-label={`${label} options`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      ><ChevronDown size={12} /></button>
      {open && createPortal(
        <div className="editor-toolbar-color-panel" role="dialog" aria-label={label} style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
          <div className="editor-toolbar-color-palette">
            <span>{colorLabels.themeColors}</span>
            <div className="editor-toolbar-color-swatches">
              {palette.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className={color.toLowerCase() === swatch.toLowerCase() ? "is-active" : undefined}
                  aria-label={`${label}: ${resolveColor(swatch)}`}
                  aria-pressed={color.toLowerCase() === swatch.toLowerCase()}
                  style={{ backgroundColor: swatch }}
                  onClick={() => { onChange(swatch); setOpen(false); }}
                />
              ))}
            </div>
          </div>
          <label>
            <span>{colorLabels.customColor}</span>
            <input ref={inputRef} type="color" value={resolveColor(color)} onChange={(event) => onChange(event.target.value)} />
          </label>
          <button type="button" onClick={() => { onReset(); setOpen(false); }}>{colorLabels.resetColor}</button>
        </div>,
        document.body,
      )}
    </div>
  );
}

const TOOLBAR_LABELS = {
  "zh-CN": {
    toolbar: "编辑工具栏",
    paragraph: "正文",
    headingLevel: (level: number) => `标题 ${level}`,
    bold: "加粗",
    italic: "斜体",
    underline: "下划线",
    strikethrough: "删除线",
    redacted: "黑幕（点击文字显示）",
    textColor: "文字颜色",
    highlight: "高亮",
    formatPainter: "格式刷（选择要应用的文本）",
    themeColors: "主题颜色",
    customColor: "自定义颜色",
    resetColor: "恢复默认",
    bulletList: "无序列表",
    orderedList: "有序列表",
    taskList: "任务列表",
    image: "图片",
    quote: "引用",
    inlineCode: "行内代码",
    moreTools: "更多工具",
    codeBlock: "代码块",
    table: "表格",
    link: "链接",
    linkUrl: "粘贴或输入链接",
    textDecoration: "文字装饰",
    alignment: "对齐方式",
    alignLeft: "左对齐",
    alignCenter: "居中对齐",
    alignRight: "右对齐",
    indent: "增加缩进",
    outdent: "减少缩进",
    undo: "撤销",
    redo: "重做",
    importMarkdown: "从剪贴板导入 Markdown",
    markdownView: "Markdown 源码",
    richTextView: "富文本",
  },
  en: {
    toolbar: "Editor toolbar",
    paragraph: "Normal text",
    headingLevel: (level: number) => `Heading ${level}`,
    bold: "Bold",
    italic: "Italic",
    underline: "Underline",
    strikethrough: "Strikethrough",
    redacted: "Spoiler mask (click text to reveal)",
    textColor: "Text color",
    highlight: "Highlight",
    formatPainter: "Format painter (select text to apply)",
    themeColors: "Theme colors",
    customColor: "Custom color",
    resetColor: "Reset to default",
    bulletList: "Bullet list",
    orderedList: "Ordered list",
    taskList: "Task list",
    image: "Image",
    quote: "Quote",
    inlineCode: "Inline code",
    moreTools: "More tools",
    codeBlock: "Code block",
    table: "Table",
    link: "Link",
    linkUrl: "Paste or enter link",
    textDecoration: "Text decoration",
    alignment: "Alignment",
    alignLeft: "Align left",
    alignCenter: "Align center",
    alignRight: "Align right",
    indent: "Increase indent",
    outdent: "Decrease indent",
    undo: "Undo",
    redo: "Redo",
    importMarkdown: "Import Markdown from clipboard",
    markdownView: "Markdown source",
    richTextView: "Rich text",
  },
};
