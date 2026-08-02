import type { NoteContent } from "@ygdria/shared";
import { marked } from "marked";
export type ConversionResult = {
  document: NoteContent;
  warnings: string[];
  frontMatter: Record<string, unknown>;
};
const ref = /(!?)\[\[note:([^|\]]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Adds imported Markdown nodes after an existing document without changing the
 * existing nodes or document-level attributes.
 */
export function appendTiptapDocument(existing: NoteContent, imported: NoteContent): NoteContent {
  return {
    ...existing,
    content: [...(existing.content ?? []), ...(imported.content ?? [])],
  };
}

export function markdownToTiptap(markdown: string): ConversionResult {
  const warnings: string[] = [];
  let source = markdown.trim();
  const frontMatter: Record<string, unknown> = {};
  const fm = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    fm[1].split("\n").forEach((line) => {
      const [key, ...value] = line.split(":");
      if (key && value.length) frontMatter[key.trim()] = value.join(":").trim();
    });
    source = source.slice(fm[0].length);
  }
  source = source
    // Keep Ygdria's spoiler mark through Markdown source editing. Markdown
    // itself has no standard spoiler syntax, so use a private token while
    // parsing, then restore it as an inline mark below.
    .replace(/<span\b[^>]*\bdata-ygdria-redacted\b[^>]*>([\s\S]*?)<\/span>/gi, (_match, text) => `[[ygdria:redacted:${encodeURIComponent(text)}]]`)
    .replace(/^\$\$\s*\n([\s\S]*?)\n\$\$\s*$/gm, (_match, formula) => `<div data-ygdria-math-block data-formula="${encodeURIComponent(formula.trim())}"></div>`)
    .replace(/^\$\$([^\n]+?)\$\$\s*$/gm, (_match, formula) => `<div data-ygdria-math-block data-formula="${encodeURIComponent(formula.trim())}"></div>`)
    // MathJax/Typora/Obsidian also use \[ ... \] for display math.
    .replace(/^\s*\\\[\s*\n([\s\S]*?)\n\\\]\s*$/gm, (_match, formula) => `<div data-ygdria-math-block data-formula="${encodeURIComponent(formula.trim())}"></div>`)
    .replace(/^\s*\\\[\s*(.+?)\s*\\\]\s*$/gm, (_match, formula) => `<div data-ygdria-math-block data-formula="${encodeURIComponent(formula.trim())}"></div>`)
    // Protect formulas before marked splits LaTeX commands such as \pm and
    // \times into separate escape tokens.
    .replace(/(?<!\\)\$([^$\n]+?)\$/g, (_match, formula) => `<span data-ygdria-math-inline data-formula="${encodeURIComponent(formula.trim())}"></span>`);
  const parsed = marked.lexer(source);
  const parsedContent = parsed.flatMap((token: any) => markdownTokenToNodes(token, warnings));
  return {
    // Never turn non-empty source into an empty document. Unsupported syntax
    // must remain visible/editable as text instead of being silently erased
    // when Markdown view commits back to rich text.
    document: {
      type: "doc",
      content: parsedContent.length
        ? parsedContent
        : source.trim()
          ? [{ type: "paragraph", content: [{ type: "text", text: source }] }]
          : [{ type: "paragraph" }],
    },
    warnings,
    frontMatter,
  };
  const content: any[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/)!;
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: [{ type: "text", text: heading[2] }],
      });
      continue;
    }
    const markdownImage = line.match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)$/)!;
    if (markdownImage) {
      content.push({ type: "image", attrs: { src: markdownImage[2], alt: markdownImage[1], title: markdownImage[3] ?? null } });
      continue;
    }
    const htmlImages = [...line.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
    if (htmlImages.length) {
      for (const image of htmlImages) {
        const tag = image[0];
        const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
        const title = tag.match(/\btitle=["']([^"']*)["']/i)?.[1] ?? null;
        content.push({ type: "image", attrs: { src: image[1], alt, title } });
      }
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      content.push({
        type: "codeBlock",
        attrs: { language: language || null },
        content: [{ type: "text", text: code.join("\n") }],
      });
      continue;
    }
    const task = line.match(/^- \[([ xX])\]\s+(.+)$/)!;
    if (task) {
      content.push({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: task[1] !== " " },
            content: [{ type: "paragraph", content: textNodes(task[2]) }],
          },
        ],
      });
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/)!;
    if (bullet) {
      content.push({
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: textNodes(bullet[1]) }] },
        ],
      });
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/)!;
    if (ordered) {
      content.push({
        type: "orderedList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: textNodes(ordered[1]) }] },
        ],
      });
      continue;
    }
    if (line.startsWith("|") && lines[i + 1]?.match(/^\|?\s*[-:]+/)) {
      const headers = line
        .split("|")
        .filter(Boolean)
        .map((x) => x.trim());
      i += 1;
      const rows: any[] = [];
      while (lines[i + 1]?.startsWith("|")) {
        const cells = lines[++i].split("|").filter(Boolean);
        rows.push({
          type: "tableRow",
          content: cells.map((c) => ({
            type: "tableCell",
            content: [{ type: "paragraph", content: textNodes(c.trim()) }],
          })),
        });
      }
      content.push({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: headers.map((h) => ({
              type: "tableHeader",
              content: [{ type: "paragraph", content: textNodes(h) }],
            })),
          },
          ...rows,
        ],
      });
      continue;
    }
    if (/<table[\s>]/i.test(line)) {
      warnings.push("HTML table imported; advanced layout may not round-trip to GFM.");
    }
    content.push({ type: "paragraph", content: textNodes(line) });
  }
  return {
    document: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    warnings,
    frontMatter,
  };
}

function markdownTokenToNodes(token: any, warnings: string[]): any[] {
  switch (token.type) {
    case "space": return [];
    case "heading": return [{ type: "heading", attrs: { level: token.depth }, content: inlineNodes(token.tokens) }];
    case "paragraph": {
      if (token.tokens?.length === 1 && token.tokens[0].type === "image") return [imageNode(token.tokens[0])];
      return [{ type: "paragraph", content: inlineNodes(token.tokens) }];
    }
    case "text": return [{ type: "paragraph", content: inlineNodes(token.tokens ?? [{ type: "text", text: token.text }]) }];
    case "code": {
      // Markdown exporters commonly leave a blank line immediately before a
      // closing fence. `marked` correctly includes it in `token.text`, but a
      // trailing line break becomes a visually empty final line in Tiptap's
      // code-block editor. Normalize only the final line breaks; whitespace
      // and blank lines within the source remain untouched.
      const code = String(token.text ?? "").replace(/(?:\r?\n)+$/, "");
      return [{ type: "codeBlock", attrs: { language: token.lang || null }, content: code ? [{ type: "text", text: code }] : [] }];
    }
    case "blockquote": return [{ type: "blockquote", content: (token.tokens ?? []).flatMap((item: any) => markdownTokenToNodes(item, warnings)) }];
    case "hr": return [{ type: "horizontalRule" }];
    case "list": return [{ type: token.ordered ? "orderedList" : "bulletList", content: (token.items ?? []).map((item: any) => ({ type: "listItem", content: (item.tokens ?? []).flatMap((child: any) => markdownTokenToNodes(child, warnings)) })) }];
    case "table": return [{ type: "table", content: [{ type: "tableRow", content: token.header.map((cell: any) => tableCell("tableHeader", cell)) }, ...token.rows.map((row: any[]) => ({ type: "tableRow", content: row.map((cell) => tableCell("tableCell", cell)) }))] }];
    case "html": return htmlToNodes(String(token.text), warnings);
    default: {
      const raw = String(token.raw ?? token.text ?? "");
      if (!raw.trim()) return [];
      warnings.push(`Unsupported Markdown token '${token.type}' was preserved as text.`);
      return [{ type: "paragraph", content: [{ type: "text", text: raw }] }];
    }
  }
}

function htmlToNodes(html: string, warnings: string[]): any[] {
  const mathInline = html.match(/<span\b[^>]*\bdata-ygdria-math-inline\b[^>]*\bdata-formula="([^"]*)"[^>]*>/i);
  if (mathInline) {
    let formula = mathInline[1];
    try { formula = decodeURIComponent(formula); } catch { /* retain malformed escape sequences */ }
    return [{ type: "mathInline", attrs: { formula } }];
  }
  const mathBlock = html.match(/<div\b[^>]*\bdata-ygdria-math-block\b[^>]*\bdata-formula="([^"]*)"[^>]*>/i);
  if (mathBlock) {
    let formula = mathBlock[1];
    try { formula = decodeURIComponent(formula); } catch { /* retain malformed escape sequences */ }
    return [{ type: "mathBlock", attrs: { formula } }];
  }
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length) {
    return tables.map((table) => {
      const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
        const cells = [...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
        return {
          type: "tableRow",
          content: cells.map((cell) => ({
            type: cell[1].toLowerCase() === "th" ? "tableHeader" : "tableCell",
            content: [{ type: "paragraph", content: textNodes(stripHtml(cell[2])) }],
          })),
        };
      });
      return { type: "table", content: rows };
    });
  }
  const images = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
  if (images.length) {
    return images.map((image) => {
      const tag = image[0];
      return {
        type: "image",
        attrs: {
          src: image[1],
          alt: tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "",
          title: tag.match(/\btitle=["']([^"']*)["']/i)?.[1] ?? null,
        },
      };
    });
  }
  const text = stripHtml(html);
  if (!text) return [];
  warnings.push("Unsupported HTML formatting imported as plain text.");
  return [{ type: "paragraph", content: textNodes(text) }];
}

function stripHtml(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .trim();
}

function tableCell(type: "tableCell" | "tableHeader", cell: any) {
  return { type, content: [{ type: "paragraph", content: inlineNodes(cell.tokens) }] };
}
function imageNode(token: any) { return { type: "image", attrs: { src: token.href, alt: token.text || "", title: token.title || null } }; }
function inlineNodes(tokens: any[] = [], marks: any[] = [], warnings: string[] = []): any[] {
  const output: any[] = [];
  for (const token of tokens) {
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      output.push(...inlineNodes(token.tokens, [...marks, { type: token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strike" }]));
    } else if (token.type === "link") {
      output.push(...inlineNodes(token.tokens, [...marks, { type: "link", attrs: { href: token.href, title: token.title || null } }], warnings));
    } else if (token.type === "codespan") output.push({ type: "text", text: token.text, marks: [...marks, { type: "code" }] });
    else if (token.type === "br") output.push({ type: "hardBreak" });
    else if (token.type === "image") output.push({ type: "text", text: token.text || token.href, marks });
    else if (token.type === "html") output.push(...htmlToNodes(token.raw ?? token.text ?? "", warnings));
    else if (token.type === "text" || token.type === "escape") output.push(...referenceTextNodes(token.text ?? token.raw ?? "", marks));
    else {
      const raw = String(token.raw ?? token.text ?? "");
      if (raw) output.push({ type: "text", text: raw, ...(marks.length ? { marks } : {}) });
    }
  }
  return output;
}
function referenceTextNodes(value: string, marks: any[]) {
  const output: any[] = [];
  const referencesAndMath = /(!?)\[\[note:([^|\]]+)(?:\|([^\]]+))?\]\]|(?<!\\)\$([^$\n]+?)\$|\[\[ygdria:redacted:([^\]]*)\]\]/g;
  let p = 0; let match: RegExpExecArray | null;
  while ((match = referencesAndMath.exec(value))) {
    if (match.index > p) output.push({ type: "text", text: value.slice(p, match.index), ...(marks.length ? { marks } : {}) });
    if (match[4]) output.push({ type: "mathInline", attrs: { formula: match[4].trim() } });
    else if (match[5] !== undefined) {
      let text = match[5];
      try { text = decodeURIComponent(text); } catch { /* retain malformed encoded text */ }
      output.push({ type: "text", text, marks: [...marks, { type: "redacted" }] });
    }
    else output.push(match[1] ? { type: "text", text: match[0], ...(marks.length ? { marks } : {}) } : { type: "noteReference", attrs: { noteId: match[2], title: match[3] || match[2] } });
    p = match.index + match[0].length;
  }
  if (p < value.length) output.push({ type: "text", text: value.slice(p), ...(marks.length ? { marks } : {}) });
  return output;
}
function textNodes(value: string): any[] {
  const output: any[] = [];
  let p = 0;
  ref.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ref.exec(value))) {
    if (m.index > p) output.push({ type: "text", text: value.slice(p, m.index) });
    output.push(
      m[1]
        ? { type: "text", text: value.slice(m.index, m.index + m[0].length) }
        : { type: "noteReference", attrs: { noteId: m[2], title: m[3] || m[2] } },
    );
    p = m.index + m[0].length;
  }
  if (p < value.length) output.push({ type: "text", text: value.slice(p) });
  return output;
}
export function tiptapToMarkdown(document: NoteContent): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  const render = (node: any): string => {
    const kids = (node.content || []).map(render).join("");
    switch (node.type) {
      case "doc":
        return kids;
      case "paragraph":
        return kids + "\n\n";
      case "text": {
        const text = node.text || "";
        return node.marks?.some((mark: any) => mark.type === "redacted")
          ? `<span data-ygdria-redacted>${text}</span>`
          : text;
      }
      case "heading":
        return "#".repeat(node.attrs?.level || 1) + " " + kids + "\n\n";
      case "codeBlock":
        return "```" + (node.attrs?.language || "") + "\n" + kids + "\n```\n\n";
      case "bulletList":
        return (node.content || []).map((x: any) => "- " + render(x).trim()).join("\n") + "\n\n";
      case "orderedList":
        return (
          (node.content || [])
            .map((x: any, i: number) => `${i + 1}. ${render(x).trim()}`)
            .join("\n") + "\n\n"
        );
      case "listItem":
        return kids;
      case "noteReference":
        return `[[note:${node.attrs.noteId}|${node.attrs.title}]]`;
      case "image":
        return `![${node.attrs.alt || ""}](${node.attrs.src || ""})`;
      case "mathInline":
        return `$${node.attrs?.formula ?? ""}$`;
      case "mathBlock":
        return `$$\n${node.attrs?.formula ?? ""}\n$$\n\n`;
      case "table":
        if (
          node.attrs?.colwidth?.some((x: any) => x) ||
          node.content?.some((r: any) =>
            r.content?.some((c: any) => c.attrs?.colspan > 1 || c.attrs?.rowspan > 1),
          )
        ) {
          warnings.push("Complex table serialized as HTML to preserve merged cells or widths.");
          return "<table>" + kids + "</table>\n\n";
        }
        return (
          (node.content || [])
            .map((r: any) => "| " + r.content.map((c: any) => render(c).trim()).join(" | ") + " |")
            .join("\n") + "\n\n"
        );
      case "tableRow":
      case "tableCell":
      case "tableHeader":
        return kids;
      default:
        return kids;
    }
  };
  return { markdown: render(document).trim() + "\n", warnings };
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
