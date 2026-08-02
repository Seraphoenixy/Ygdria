import React, { useEffect, useRef } from "react";
import type { NoteContent } from "@ygdria/shared";
import { StaticCodeBlock } from "./code-highlighting.js";
import { YgdriaEditor } from "./YgdriaEditor.js";
import katex from "katex";
export function StaticDocument({ document }: { document: NoteContent }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hideAll = () => rootRef.current?.querySelectorAll("[data-ygdria-redacted].is-revealed").forEach((element) => element.classList.remove("is-revealed"));

  useEffect(() => {
    const hideOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof globalThis.Node) || rootRef.current?.contains(event.target)) return;
      hideAll();
    };
    window.document.addEventListener("pointerdown", hideOnOutsidePointer);
    return () => window.document.removeEventListener("pointerdown", hideOnOutsidePointer);
  }, []);

  return (
    <div ref={rootRef} className="ygdria-document" onClick={(event) => {
      const redacted = (event.target as HTMLElement).closest<HTMLElement>("[data-ygdria-redacted]");
      const wasRevealed = redacted?.classList.contains("is-revealed");
      hideAll();
      if (redacted && !wasRevealed) redacted.classList.add("is-revealed");
    }}>
      {(document.content ?? []).map((node: any, i) => (
        <Node node={node} key={i} />
      ))}
    </div>
  );
}
function Node({ node }: { node: any }): React.ReactNode {
  const c = (node.content ?? []).map((x: any, i: number) => <Node node={x} key={i} />);
  if (node.type === "text") return renderText(node);
  if (node.type === "hardBreak") return <br />;
  if (node.type === "horizontalRule") return <hr />;
  if (node.type === "paragraph") {
    const style = node.attrs?.textAlign ? { textAlign: node.attrs.textAlign } : undefined;
    return <p style={style}>{c.length > 0 ? c : <br />}</p>;
  }
  if (node.type === "heading") {
    const Tag = `h${node.attrs?.level || 1}` as keyof React.JSX.IntrinsicElements;
    const style = node.attrs?.textAlign ? { textAlign: node.attrs.textAlign } : undefined;
    return <Tag style={style}>{c}</Tag>;
  }
  if (node.type === "bulletList") return <ul>{c}</ul>;
  if (node.type === "orderedList") return <ol>{c}</ol>;
  if (node.type === "listItem") return <li>{c}</li>;
  if (node.type === "taskItem")
    return (
      <li data-type="taskItem" data-checked={node.attrs?.checked ? "true" : "false"}>
        <label>
          <input type="checkbox" checked={Boolean(node.attrs?.checked)} readOnly />
          <span />
        </label>
        <div>{c}</div>
      </li>
    );
  if (node.type === "taskList") return <ul data-type="taskList">{c}</ul>;
  if (node.type === "blockquote") return <blockquote>{c}</blockquote>;
  if (node.type === "codeBlock")
    // Tiptap defers DOM creation during SSR. Browser clients use the exact
    // same node view and decoration pipeline as editing; the static fallback
    // keeps server-side previews safe and meaningful.
    return typeof window === "undefined"
      ? <StaticCodeBlock code={nodeText(node)} language={node.attrs?.language} />
      : <YgdriaEditor
      content={{ type: "doc", content: [node] }}
      readOnly
    />;
  if (node.type === "noteReference")
    return <span className="note-reference">{node.attrs.title}</span>;
  if (node.type === "image") return <img src={node.attrs.src} alt={node.attrs.alt || ""} />;
  if (node.type === "mathInline" || node.type === "mathBlock") {
    const displayMode = node.type === "mathBlock";
    const html = katex.renderToString(node.attrs?.formula ?? "", { displayMode, throwOnError: false, trust: false });
    const Tag = displayMode ? "div" : "span";
    return <Tag className={`ygdria-math ${displayMode ? "ygdria-math-block" : "ygdria-math-inline"}`} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (node.type === "table")
    return (
      <div className="tableWrapper">
        <table>
          {tableColgroup(node)}
          <tbody>{c}</tbody>
        </table>
      </div>
    );
  if (node.type === "tableRow") return <tr>{c}</tr>;
  if (node.type === "tableHeader")
    return (
      <th colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>
        {c}
      </th>
    );
  if (node.type === "tableCell")
    return (
      <td colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>
        {c}
      </td>
    );
  return <>{c}</>;
}

function nodeText(node: any): string {
  if (node.type === "text") return node.text || "";
  return (node.content ?? []).map(nodeText).join("");
}

/**
 * Renders a <colgroup> from the first row's cell `colwidth` attributes
 * (ProseMirror/Tiptap convention: each cell carries the width of the columns
 * it spans). Preserves user-adjusted column widths in static/read-only views,
 * which otherwise would fall back to browser auto-layout.
 */
function tableColgroup(table: any): React.ReactNode {
  const firstRow = table.content?.[0];
  if (!firstRow?.content?.length) return null;
  const widths: (number | null)[] = [];
  for (const cell of firstRow.content) {
    const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1);
    const colwidth = Array.isArray(cell.attrs?.colwidth) ? cell.attrs.colwidth : [];
    for (let i = 0; i < colspan; i++) {
      widths.push(typeof colwidth[i] === "number" && colwidth[i] > 0 ? colwidth[i] : null);
    }
  }
  if (!widths.some((width) => width)) return null;
  return (
    <colgroup>
      {widths.map((width, i) => (width ? <col key={i} style={{ width: `${width}px` }} /> : <col key={i} />))}
    </colgroup>
  );
}

function renderText(node: any): React.ReactNode {
  let content: React.ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        content = <strong>{content}</strong>;
        break;
      case "italic":
        content = <em>{content}</em>;
        break;
      case "strike":
        content = <s>{content}</s>;
        break;
      case "underline":
        content = <u>{content}</u>;
        break;
      case "code":
        content = <code>{content}</code>;
        break;
      case "link":
        content = (
          <a href={mark.attrs?.href} target="_blank" rel="noreferrer">
            {content}
          </a>
        );
        break;
      case "highlight":
        content = (
          <mark style={{ backgroundColor: mark.attrs?.color || "#FAF594" }}>
            {content}
          </mark>
        );
        break;
      case "textStyle": {
        const style: React.CSSProperties = {};
        if (mark.attrs?.color) style.color = mark.attrs.color;
        if (mark.attrs?.fontSize) style.fontSize = mark.attrs.fontSize;
        if (Object.keys(style).length > 0) {
          content = <span style={style}>{content}</span>;
        }
        break;
      }
      case "redacted":
        content = <span className="ygdria-redacted" data-ygdria-redacted="" role="button" tabIndex={0} aria-label="Reveal sensitive text">{content}</span>;
        break;
    }
  }
  return content;
}
