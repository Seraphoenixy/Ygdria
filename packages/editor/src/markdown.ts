import type { NoteContent } from "@ygdria/shared";
import { Marked, type Token } from "marked";
import {
  blockNodes,
  escapeHtml,
  htmlToRichNodes,
  richNodeToHtml,
  type RichNode,
} from "./markdown-html.js";

export type ConversionResult = {
  document: NoteContent;
  warnings: string[];
  frontMatter: Record<string, unknown>;
};

// Lex extensions respect code boundaries. Whole-source replacements would
// accidentally interpret formulas/references inside fenced or inline code.
const parser = new Marked({
  extensions: [
    {
      name: "ygdriaMathBlock",
      level: "block",
      start: (src) =>
        src.search(
          /^(?: {0,3}\$\$[\s\S]*?\$\$[ \t]*(?:\n|$)| {0,3}\\\[[\s\S]*?\\\][ \t]*(?:\n|$))/m,
        ),
      tokenizer(src) {
        const match =
          /^(?: {0,3}\$\$[ \t]*\n([\s\S]*?)\n {0,3}\$\$[ \t]*(?:\n|$)| {0,3}\$\$([^\n]+?)\$\$[ \t]*(?:\n|$)| {0,3}\\\[[ \t]*\n([\s\S]*?)\n {0,3}\\\][ \t]*(?:\n|$)| {0,3}\\\[[ \t]*(.+?)[ \t]*\\\][ \t]*(?:\n|$))/.exec(
            src,
          );
        if (match)
          return {
            type: "ygdriaMathBlock",
            raw: match[0],
            formula: (match[1] ?? match[2] ?? match[3] ?? match[4]).trim(),
          };
      },
      renderer: (token) =>
        `<div data-ygdria-math-block data-formula="${escapeHtml(encodeURIComponent(token.formula))}"></div>`,
    },
    {
      name: "ygdriaMathInline",
      level: "inline",
      start: (src) => src.indexOf("$"),
      tokenizer(src) {
        const match = /^\$([^$\n]+?)\$(?!\$)/.exec(src);
        if (match) return { type: "ygdriaMathInline", raw: match[0], formula: match[1].trim() };
      },
      renderer: (token) =>
        `<span data-ygdria-math-inline data-formula="${escapeHtml(encodeURIComponent(token.formula))}"></span>`,
    },
    {
      name: "ygdriaReference",
      level: "inline",
      start: (src) => src.indexOf("[[note:"),
      tokenizer(src) {
        const match = /^(!?)\[\[note:([^|\]]+)(?:\|([^\]]+))?\]\]/.exec(src);
        if (match)
          return {
            type: "ygdriaReference",
            raw: match[0],
            embedded: Boolean(match[1]),
            noteId: match[2],
            title: match[3] ?? match[2],
          };
      },
      renderer: (token) =>
        token.embedded
          ? escapeHtml(token.raw)
          : `<span data-note-id="${escapeHtml(token.noteId)}" data-note-title="${escapeHtml(token.title)}"></span>`,
    },
  ],
});

/** Append imported nodes without changing the existing document or attributes. */
export function appendTiptapDocument(existing: NoteContent, imported: NoteContent): NoteContent {
  return { ...existing, content: [...(existing.content ?? []), ...(imported.content ?? [])] };
}

export function markdownToTiptap(markdown: string): ConversionResult {
  const warnings: string[] = [];
  let source = markdown.replace(/\r\n?/g, "\n").trim();
  const frontMatter: Record<string, unknown> = {};
  const fm = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const [key, ...value] = line.split(":");
      if (key && value.length) frontMatter[key.trim()] = value.join(":").trim();
    }
    source = source.slice(fm[0].length);
  }
  const content = parser.lexer(source).flatMap((token) => markdownTokenToNodes(token, warnings));
  return {
    document: {
      type: "doc",
      content: content.length
        ? content
        : [
            {
              type: "paragraph",
              ...(source.trim() ? { content: [{ type: "text", text: source }] } : {}),
            },
          ],
    },
    warnings: [...new Set(warnings)],
    frontMatter,
  };
}

function inlineNodes(tokens: Token[] = [], warnings: string[]): RichNode[] {
  return htmlToRichNodes(
    parser.Parser.parseInline(
      tokens.filter((token) => token.type !== "checkbox"),
      parser.defaults,
    ),
    warnings,
  );
}

function markdownTokenToNodes(token: any, warnings: string[]): RichNode[] {
  switch (token.type) {
    case "space":
      return [];
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: token.depth },
          content: inlineNodes(token.tokens, warnings),
        },
      ];
    case "paragraph":
    case "text":
      return blockNodes(
        inlineNodes(
          token.tokens ?? [{ type: "text", raw: token.text, text: token.text }],
          warnings,
        ),
      );
    case "code": {
      // Keep the established clipboard normalization for fenced imports.
      // Native code with significant trailing newlines exports as <pre>.
      const code = String(token.text ?? "").replace(/\n+$/, "");
      return [
        {
          type: "codeBlock",
          attrs: { language: token.lang || null },
          content: code ? [{ type: "text", text: code }] : [],
        },
      ];
    }
    case "blockquote":
      return [
        {
          type: "blockquote",
          content: (token.tokens ?? []).flatMap((child: any) =>
            markdownTokenToNodes(child, warnings),
          ),
        },
      ];
    case "hr":
      return [{ type: "horizontalRule" }];
    case "list": {
      const lists: RichNode[] = [];
      for (const [index, item] of token.items.entries()) {
        const type = item.task ? "taskList" : token.ordered ? "orderedList" : "bulletList";
        let list = lists.at(-1);
        if (list?.type !== type) {
          list = {
            type,
            ...(type === "orderedList" ? { attrs: { start: (token.start || 1) + index } } : {}),
            content: [],
          };
          lists.push(list);
        }
        const content = (item.tokens ?? [])
          .filter((child: any) => child.type !== "checkbox")
          .flatMap((child: any) => markdownTokenToNodes(child, warnings));
        list!.content!.push({
          type: item.task ? "taskItem" : "listItem",
          ...(item.task ? { attrs: { checked: Boolean(item.checked) } } : {}),
          content: content.length ? content : [{ type: "paragraph" }],
        });
      }
      return lists;
    }
    case "table": {
      const cell = (type: string, value: any, index: number): RichNode => ({
        type,
        content: [
          {
            type: "paragraph",
            ...(token.align[index] ? { attrs: { textAlign: token.align[index] } } : {}),
            content: inlineNodes(value.tokens, warnings),
          },
        ],
      });
      return [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: token.header.map((value: any, i: number) => cell("tableHeader", value, i)),
            },
            ...token.rows.map((row: any[]) => ({
              type: "tableRow",
              content: row.map((value, i) => cell("tableCell", value, i)),
            })),
          ],
        },
      ];
    }
    case "html":
      return blockNodes(htmlToRichNodes(String(token.text), warnings));
    case "ygdriaMathBlock":
      return [{ type: "mathBlock", attrs: { formula: token.formula } }];
    default: {
      const raw = String(token.raw ?? token.text ?? "");
      if (!raw.trim()) return [];
      warnings.push(`Unsupported Markdown token '${token.type}' was preserved as text.`);
      return [{ type: "paragraph", content: [{ type: "text", text: raw }] }];
    }
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~$<>&:-]/g, (char) =>
    char === "[" ? "&#91;" : "\\" + char,
  );
}

function codeSpan(value: string): string {
  const fence = "`".repeat(
    Math.max(0, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length)) + 1,
  );
  const pad =
    value.startsWith("`") || value.endsWith("`") || (/^ .* $/.test(value) && value.trim())
      ? " "
      : "";
  return fence + pad + value + pad + fence;
}

export function tiptapToMarkdown(document: NoteContent): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  const html = (node: RichNode) => richNodeToHtml(node, warnings);
  const needsHtml = (node: RichNode): boolean => {
    if (node.attrs?.textAlign && node.attrs.textAlign !== "left") return true;
    if (
      ["paragraph", "heading"].includes(node.type) &&
      (!node.content?.length ||
        /^\s/.test(node.content[0]?.text ?? "") ||
        /\s$/.test(node.content.at(-1)?.text ?? ""))
    )
      return true;
    if (node.type === "text") {
      const marks = node.marks ?? [];
      return (
        marks.length > 1 ||
        marks.some((m) => !["bold", "italic", "strike", "code", "link"].includes(m.type)) ||
        marks.some(
          (m) =>
            (m.type === "link" &&
              (/[\s<>]/.test(m.attrs?.href ?? "") ||
                Boolean(m.attrs?.target) ||
                Boolean(m.attrs?.rel))) ||
            (m.type === "code" && /\n/.test(node.text ?? "")),
        ) ||
        (marks.length > 0 && /^\s|\s$/.test(node.text ?? "")) ||
        /[\r\n]/.test(node.text ?? "")
      );
    }
    const children = node.content ?? [];
    return children.some(
      (child, i) =>
        needsHtml(child) ||
        (i > 0 && Boolean(child.marks?.length) && Boolean(children[i - 1].marks?.length)),
    );
  };
  const quoteTitle = (title: unknown) =>
    title == null ? "" : ` "${String(title).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const destination = (src: string) => (src.includes("(") || src.includes(")") ? `<${src}>` : src);
  const render = (node: RichNode): string => {
    const children = node.content ?? [];
    const kids = () => children.map(render).join("");
    switch (node.type) {
      case "doc":
        return kids();
      case "paragraph":
      case "heading": {
        if (needsHtml(node)) return html(node) + "\n\n";
        return (
          (node.type === "heading" ? "#".repeat(node.attrs?.level || 1) + " " : "") +
          kids() +
          "\n\n"
        );
      }
      case "text": {
        const mark = node.marks?.[0];
        if (needsHtml(node)) return html(node);
        if (mark?.type === "code") return codeSpan(node.text ?? "");
        const value = escapeMarkdown(node.text ?? "");
        if (!mark) return value;
        if (mark.type === "bold") return `**${value}**`;
        if (mark.type === "italic") return `*${value}*`;
        if (mark.type === "strike") return `~~${value}~~`;
        if (mark.type === "link") {
          const href = String(mark.attrs?.href ?? "");
          // Encoding a URL here would change it on reimport; HTML is lossless.
          if (/[\s<>]/.test(href)) return html(node);
          return `[${value}](${destination(href)}${quoteTitle(mark.attrs?.title)})`;
        }
        return html(node);
      }
      case "hardBreak":
        return "  \n";
      case "horizontalRule":
        return "***\n\n";
      case "blockquote":
        return (
          kids()
            .trimEnd()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n") + "\n\n"
        );
      case "codeBlock": {
        const code = children.map((child) => child.text ?? "").join("");
        if (/\n$|\r/.test(code) || /[\s`]/.test(node.attrs?.language ?? ""))
          return html(node) + "\n\n";
        const fence = "`".repeat(
          Math.max(2, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length)) + 1,
        );
        return `${fence}${node.attrs?.language || ""}\n${code}\n${fence}\n\n`;
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        return (
          children
            .map((item, i) => {
              const marker =
                node.type === "orderedList"
                  ? `${(node.attrs?.start ?? 1) + i}. `
                  : node.type === "taskList"
                    ? `- [${item.attrs?.checked ? "x" : " "}] `
                    : "- ";
              const content = (item.content ?? []).map(render).join("").trimEnd();
              const lines = content.split("\n");
              const indent = node.type === "orderedList" ? marker.length : 2;
              return (
                marker +
                lines[0] +
                lines
                  .slice(1)
                  .map((line) => "\n" + " ".repeat(indent) + line)
                  .join("")
              );
            })
            .join("\n\n") + "\n\n"
        );
      case "noteReference": {
        const { noteId = "", title = "" } = node.attrs ?? {};
        return /[\]|\n]/.test(noteId) || /[\]\n]/.test(title)
          ? html(node)
          : `[[note:${noteId}|${title}]]`;
      }
      case "image": {
        const { src = "", alt = "", title, width, height } = node.attrs ?? {};
        if (width || height || /[\s<>]/.test(src)) return html(node) + "\n\n";
        return `![${escapeMarkdown(alt)}](${destination(src)}${quoteTitle(title)})\n\n`;
      }
      case "mathInline":
        return `$${node.attrs?.formula ?? ""}$`;
      case "mathBlock":
        return `$$\n${node.attrs?.formula ?? ""}\n$$\n\n`;
      case "table": {
        const rows = children;
        const complex =
          node.attrs?.colwidth?.some((w: unknown) => w) ||
          !rows.length ||
          rows.some((row, i) =>
            row.content?.some(
              (cell) =>
                (i === 0 && cell.type !== "tableHeader") ||
                (i > 0 && cell.type !== "tableCell") ||
                cell.attrs?.colspan > 1 ||
                cell.attrs?.rowspan > 1 ||
                cell.attrs?.colwidth?.some((w: unknown) => w) ||
                cell.content?.length !== 1 ||
                cell.content?.[0]?.type !== "paragraph" ||
                needsHtml(cell) ||
                cell.content?.[0]?.content?.some(
                  (n) =>
                    n.type === "hardBreak" ||
                    (n.marks?.some((m) => m.type === "code") && n.text?.includes("|")),
                ),
            ),
          ) ||
          rows.some((row) => row.content?.length !== rows[0].content?.length);
        if (complex) {
          warnings.push(
            "Complex table serialized as HTML to preserve merged cells, widths or rich content.",
          );
          return html(node) + "\n\n";
        }
        const row = (value: RichNode) =>
          "| " +
          (value.content ?? [])
            .map((cell) => render(cell.content![0]).trim().replaceAll("\n", "<br>"))
            .join(" | ") +
          " |";
        const alignments: Record<string, string> = { left: ":---", right: "---:", center: ":---:" };
        const delimiter =
          "| " +
          (rows[0].content ?? [])
            .map((cell) => alignments[cell.content?.[0]?.attrs?.textAlign] ?? "---")
            .join(" | ") +
          " |";
        return [row(rows[0]), delimiter, ...rows.slice(1).map(row)].join("\n") + "\n\n";
      }
      case "listItem":
      case "taskItem":
      case "tableRow":
      case "tableCell":
      case "tableHeader":
        return kids();
      default:
        warnings.push(`Unsupported node '${node.type}' formatting was omitted.`);
        return kids();
    }
  };
  return {
    markdown: render(document as RichNode).trimEnd() + "\n",
    warnings: [...new Set(warnings)],
  };
}

export function plainText(document: NoteContent) {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.type === "text" && n.text) out.push(n.text);
    if (n.type === "noteReference") out.push(n.attrs.title);
    (n.content || []).forEach(walk);
  };
  walk(document);
  return out.join(" ");
}
