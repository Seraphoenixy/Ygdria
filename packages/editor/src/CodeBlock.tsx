import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { findChildren } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Check, Copy } from "lucide-react";
import {
  CODE_LANGUAGES,
  editorLowlight,
  highlightCode,
  isCodeTooLarge,
  normalizeCodeLanguage,
} from "./code-highlighting.js";

type FlatToken = { text: string; classes: string[] };
type HighlightNode = { value?: string; properties?: { className?: string | string[] }; children?: HighlightNode[] };

function flatten(nodes: HighlightNode[] | undefined, inherited: string[] = []): FlatToken[] {
  return (nodes ?? []).flatMap((node) => {
    const own = node.properties?.className;
    const classes = [...inherited, ...(Array.isArray(own) ? own : own ? [own] : [])];
    if (node.children) return flatten(node.children, classes);
    return [{ text: node.value || "", classes }];
  });
}

function blockDecorations(block: { pos: number; node: { textContent: string; attrs: { language?: string }; nodeSize: number } }) {
  let from = block.pos + 1;
  const decorations: Decoration[] = [];
  const highlighted = highlightCode(block.node.textContent, block.node.attrs.language);
  for (const token of flatten(highlighted.tree.children)) {
    const to = from + token.text.length;
    if (token.classes.length && to > from) decorations.push(Decoration.inline(from, to, { class: token.classes.join(" ") }));
    from = to;
  }
  return decorations;
}

function allDecorations(doc: Parameters<typeof findChildren>[0]) {
  const decorations = findChildren(doc, (node) => node.type.name === "codeBlock").flatMap((block) => blockDecorations(block as any));
  return DecorationSet.create(doc, decorations);
}

const highlightPluginKey = new PluginKey<DecorationSet>("ygdria-code-highlighting");

function currentCodeBlock(state: any) {
  const head = state.selection.head;
  return findChildren(state.doc, (node) => node.type.name === "codeBlock")
    .find((block) => block.pos < head && block.pos + block.node.nodeSize >= head);
}

function debouncedHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: highlightPluginKey,
    state: {
      init: (_, state) => allDecorations(state.doc),
      apply(transaction, decorations, _oldState, newState) {
        const mapped = decorations.map(transaction.mapping, transaction.doc);
        const refresh = transaction.getMeta(highlightPluginKey) as "all" | "current" | undefined;
        if (!refresh) return mapped;
        if (refresh === "all") return allDecorations(newState.doc);
        const block = currentCodeBlock(newState);
        if (!block) return mapped;
        const from = block.pos + 1;
        const to = block.pos + block.node.nodeSize - 1;
        return mapped.remove(mapped.find(from, to)).add(newState.doc, blockDecorations(block as any));
      },
    },
    props: { decorations: (state) => highlightPluginKey.getState(state) },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(nextView, previousState) {
          if (nextView.state.doc.eq(previousState.doc) && nextView.state.selection.eq(previousState.selection)) return;
          const oldCount = findChildren(previousState.doc, (node) => node.type.name === "codeBlock").length;
          const newCount = findChildren(nextView.state.doc, (node) => node.type.name === "codeBlock").length;
          const changedInCode = previousState.selection.$head.parent.type.name === "codeBlock" || nextView.state.selection.$head.parent.type.name === "codeBlock";
          if (oldCount === newCount && !changedInCode) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (!nextView.isDestroyed) nextView.dispatch(nextView.state.tr.setMeta(highlightPluginKey, oldCount === newCount ? "current" : "all"));
          }, 120);
        },
        destroy() { if (timer) clearTimeout(timer); },
      };
    },
  });
}

function CodeBlockNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const [lineTops, setLineTops] = useState<number[]>([]);
  const [editable, setEditable] = useState(editor.isEditable);
  const codePreRef = useRef<HTMLPreElement>(null);
  const code = node.textContent;
  const tooLarge = isCodeTooLarge(code);
  const language = normalizeCodeLanguage(node.attrs.language);
  const lines = useMemo(() => code.split("\n"), [code]);
  useLayoutEffect(() => {
    const syncEditable = () => setEditable(editor.isEditable);
    editor.on("update", syncEditable);
    return () => { editor.off("update", syncEditable); };
  }, [editor]);
  useLayoutEffect(() => {
    const pre = codePreRef.current;
    if (!pre) return;
    let frame = 0;
    const updateLineTops = () => {
      const content = pre.querySelector("[data-node-view-content]") ?? pre.firstElementChild;
      if (!content) return;
      const textNodes: Text[] = [];
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let current = walker.nextNode(); current; current = walker.nextNode()) textNodes.push(current as Text);
      const starts = [0];
      for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) starts.push(index + 1);
      const preTop = pre.getBoundingClientRect().top;
      const computedStyle = getComputedStyle(pre);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight);
      const fontSize = Number.parseFloat(computedStyle.fontSize);
      // Range rectangles follow the rendered glyph area, while `top` on a
      // gutter span positions its whole line box. Remove the line box's upper
      // leading so both sets of glyphs share the same baseline.
      const upperLeading = Number.isFinite(lineHeight) && Number.isFinite(fontSize)
        ? Math.max(0, (lineHeight - fontSize) / 2)
        : 0;
      let nodeIndex = 0;
      let consumed = 0;
      const pointAt = (offset: number) => {
        let index = 0;
        let total = 0;
        while (index < textNodes.length - 1 && offset >= total + textNodes[index].data.length) {
          total += textNodes[index].data.length;
          index += 1;
        }
        const textNode = textNodes[index];
        return textNode
          ? { textNode, offset: Math.min(Math.max(0, offset - total), textNode.data.length) }
          : undefined;
      };
      const tops = starts.map((start, lineIndex) => {
        while (nodeIndex < textNodes.length - 1 && start >= consumed + textNodes[nodeIndex].data.length) {
          consumed += textNodes[nodeIndex].data.length;
          nodeIndex += 1;
        }
        const textNode = textNodes[nodeIndex];
        if (!textNode) return lineIndex * 23.1;
        const range = document.createRange();
        const startPoint = pointAt(start);
        if (!startPoint) return lineIndex * 23.1;
        const lineEnd = code.indexOf("\n", start);
        let measuredEmptyLine = false;
        if (lineEnd === start && start < code.length) {
          // A collapsed range at an empty line is ambiguously reported as an
          // adjacent line by Chromium. Measure the line's own newline glyph.
          const endPoint = pointAt(start + 1);
          if (endPoint) {
            range.setStart(startPoint.textNode, startPoint.offset);
            range.setEnd(endPoint.textNode, endPoint.offset);
            measuredEmptyLine = true;
          }
        }
        if (!measuredEmptyLine) {
          range.setStart(startPoint.textNode, startPoint.offset);
          range.collapse(true);
        }
        const rect = range.getClientRects()[0];
        return rect ? rect.top - preTop - upperLeading : lineIndex * 23.1;
      });
      setLineTops((previous) => previous.length === tops.length && previous.every((top, index) => Math.abs(top - tops[index]) < 0.5) ? previous : tops);
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateLineTops);
    };
    scheduleUpdate();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleUpdate);
    observer?.observe(pre);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [code, editable]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be unavailable in insecure browser contexts.
    }
  };
  return <NodeViewWrapper className={`ygdria-code-block${tooLarge ? " is-large-plain" : ""}`} data-language={language}>
    <div className="ygdria-code-block-toolbar" contentEditable={false}>
      <select
        value={language}
        disabled={!editable}
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => updateAttributes({ language: event.target.value })}
        aria-label="代码语言 / Code language"
      >
        {CODE_LANGUAGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <div className="ygdria-code-block-actions">
        {tooLarge && <span>Plain</span>}
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={copy} title={copied ? "已复制 / Copied" : "复制代码 / Copy code"} aria-label={copied ? "已复制 / Copied" : "复制代码 / Copy code"}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
    <div className="ygdria-code-block-body">
      <div className={`ygdria-code-block-gutter${lineTops.length === lines.length ? " is-measured" : ""}`} aria-hidden="true" contentEditable={false}>
        {lines.map((_, i) => <span key={i} style={lineTops.length === lines.length ? { top: `${lineTops[i]}px` } : undefined}>{i + 1}</span>)}
      </div>
      <pre ref={codePreRef}><NodeViewContent as={"code" as any} /></pre>
    </div>
  </NodeViewWrapper>;
}

export const YgdriaCodeBlock = CodeBlockLowlight.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockNodeView); },
  addProseMirrorPlugins() { return [debouncedHighlightPlugin()]; },
}).configure({ lowlight: editorLowlight, defaultLanguage: "plaintext", enableTabIndentation: true, tabSize: 4 });
