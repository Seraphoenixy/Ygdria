import { parseDocument } from "htmlparser2";

export type RichNode = {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: RichMark[];
  content?: RichNode[];
};
type RichMark = { type: string; attrs?: Record<string, any> };
type HtmlNode = ReturnType<typeof parseDocument>["children"][number];

export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // Blank lines terminate Markdown HTML blocks (except pre/script/style).
    // Encode text newlines so the remainder of a rich paragraph is never
    // reparsed as Markdown, while the inert HTML parser restores them exactly.
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");

function safeUrl(value: string, image = false) {
  const normalized = value.replace(/[\u0000-\u0020\u007f]/g, "");
  return (
    !/^[a-z][a-z\d+.-]*:/i.test(normalized) ||
    /^(https?:|mailto:|tel:)/i.test(normalized) ||
    (image && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(normalized))
  );
}

function styleValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[#\w(),.%\s+-]+$/.test(value) ? value : undefined;
}

function styles(value = ""): Record<string, string> {
  return Object.fromEntries(
    value.split(";").flatMap((part) => {
      const colon = part.indexOf(":");
      if (colon < 0) return [];
      const key = part.slice(0, colon).trim().toLowerCase();
      const val = styleValue(part.slice(colon + 1).trim());
      return val ? [[key, val]] : [];
    }),
  );
}

/** Groups inline runs into paragraphs without nesting block images in paragraphs. */
export function blockNodes(nodes: RichNode[], preserveWhitespace = false): RichNode[] {
  const result: RichNode[] = [];
  let inline: RichNode[] = [];
  const flush = () => {
    if (
      inline.length &&
      (preserveWhitespace || inline.some((node) => node.type !== "text" || node.text?.trim()))
    )
      result.push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (const node of nodes) {
    if (["text", "hardBreak", "noteReference", "mathInline"].includes(node.type)) inline.push(node);
    else {
      flush();
      result.push(node);
    }
  }
  flush();
  return result;
}

/** Parse inert HTML with a whitelist; no DOM, scripts, resource loads or event handlers. */
export function htmlToRichNodes(html: string, warnings: string[]): RichNode[] {
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const visit = (node: HtmlNode, marks: RichMark[] = []): RichNode[] => {
    if (node.type === "text")
      return node.data
        ? [{ type: "text", text: node.data, ...(marks.length ? { marks } : {}) }]
        : [];
    if (!("name" in node) || !("attribs" in node)) return [];
    const name = node.name.toLowerCase();
    const attrs = node.attribs;
    const css = styles(attrs.style);
    const children = (next = marks) => node.children.flatMap((child) => visit(child, next));
    const mark = (type: string, attrs?: Record<string, any>) =>
      children([...marks, { type, ...(attrs ? { attrs } : {}) }]);
    if (["script", "style", "iframe", "object", "svg", "math"].includes(name)) {
      warn(`Unsupported HTML element '${name}' was preserved as text.`);
      return [
        {
          type: "text",
          text: node.children.map((child) => ("data" in child ? child.data : "")).join(""),
        },
      ];
    }
    if (name === "span" && "data-ygdria-math-inline" in attrs)
      return [{ type: "mathInline", attrs: { formula: decode(attrs["data-formula"] ?? "") } }];
    if (name === "div" && "data-ygdria-math-block" in attrs)
      return [{ type: "mathBlock", attrs: { formula: decode(attrs["data-formula"] ?? "") } }];
    if (name === "span" && attrs["data-note-id"])
      return [
        {
          type: "noteReference",
          attrs: { noteId: attrs["data-note-id"], title: attrs["data-note-title"] ?? "" },
        },
      ];
    if (name === "span" && "data-ygdria-redacted" in attrs) return mark("redacted");
    if (["strong", "b"].includes(name)) return mark("bold");
    if (["em", "i"].includes(name)) return mark("italic");
    if (["s", "del", "strike"].includes(name)) return mark("strike");
    if (name === "u") return mark("underline");
    if (name === "code") return mark("code");
    if (name === "mark")
      return mark("highlight", { color: css["background-color"] ?? attrs["data-color"] ?? null });
    if (name === "span" && (css.color || css["font-size"]))
      return mark("textStyle", {
        ...(css.color ? { color: css.color } : {}),
        ...(css["font-size"] ? { fontSize: css["font-size"] } : {}),
      });
    if (name === "a") {
      if (safeUrl(attrs.href ?? ""))
        return mark("link", {
          href: attrs.href ?? "",
          title: attrs.title ?? null,
          ...(attrs.target ? { target: attrs.target } : {}),
          ...(attrs.rel ? { rel: attrs.rel } : {}),
        });
      warn("Unsafe link destination was omitted.");
      return children();
    }
    if (name === "br") return [{ type: "hardBreak" }];
    if (name === "hr") return [{ type: "horizontalRule" }];
    if (name === "img") {
      if (!safeUrl(attrs.src ?? "", true)) {
        warn("Unsafe image source was omitted.");
        return [{ type: "text", text: attrs.alt || attrs.src || "" }];
      }
      return [
        {
          type: "image",
          attrs: {
            src: attrs.src ?? "",
            alt: attrs.alt ?? "",
            title: attrs.title ?? null,
            ...Object.fromEntries(
              ["width", "height"]
                .filter((key) => /^\d+$/.test(attrs[key] ?? ""))
                .map((key) => [key, Number(attrs[key])]),
            ),
          },
        },
      ];
    }
    if (name === "pre") {
      const code = node.children.find((child) => "name" in child && child.name === "code");
      const text = (n: HtmlNode): string =>
        n.type === "text" ? n.data : "children" in n ? n.children.map(text).join("") : "";
      const language =
        code && "attribs" in code
          ? (code.attribs["data-language"] ??
            (code.attribs.class ?? "").match(/(?:^|\s)language-([^\s]+)/)?.[1])
          : undefined;
      const value = node.children.map(text).join("");
      return [
        {
          type: "codeBlock",
          attrs: { language: language ?? null },
          content: value ? [{ type: "text", text: value }] : [],
        },
      ];
    }
    if (name === "p" || /^h[1-6]$/.test(name)) {
      const alignment = ["left", "center", "right", "justify"].includes(css["text-align"])
        ? css["text-align"]
        : undefined;
      const content = children();
      if (name === "p" && content.some((n) => n.type === "image")) return blockNodes(content, true);
      return [
        {
          type: name === "p" ? "paragraph" : "heading",
          ...(alignment || name !== "p"
            ? {
                attrs: {
                  ...(name !== "p" ? { level: Number(name[1]) } : {}),
                  ...(alignment ? { textAlign: alignment } : {}),
                },
              }
            : {}),
          ...(content.length ? { content } : {}),
        },
      ];
    }
    if (name === "table") {
      const content = children().filter((n) => n.type === "tableRow");
      let widths: unknown;
      try {
        widths = JSON.parse(attrs["data-colwidth"] ?? "null");
      } catch {
        /* ignore malformed metadata */
      }
      return [
        {
          type: "table",
          ...(Array.isArray(widths) &&
          widths.every((w) => w === null || (Number.isFinite(w) && Number(w) > 0))
            ? { attrs: { colwidth: widths } }
            : {}),
          content,
        },
      ];
    }
    if (name === "tr")
      return [
        {
          type: "tableRow",
          content: children().filter((n) => ["tableCell", "tableHeader"].includes(n.type)),
        },
      ];
    if (name === "th" || name === "td") {
      const cellAttrs: Record<string, any> = {};
      for (const key of ["colspan", "rowspan"])
        if (/^[1-9]\d*$/.test(attrs[key] ?? "")) cellAttrs[key] = Number(attrs[key]);
      const width = attrs["data-colwidth"]?.split(",").map(Number);
      if (width?.length && width.every((w) => Number.isFinite(w) && w >= 0))
        cellAttrs.colwidth = width;
      const content = blockNodes(children());
      return [
        {
          type: name === "th" ? "tableHeader" : "tableCell",
          ...(Object.keys(cellAttrs).length ? { attrs: cellAttrs } : {}),
          content: content.length ? content : [{ type: "paragraph" }],
        },
      ];
    }
    if (name === "blockquote") return [{ type: "blockquote", content: blockNodes(children()) }];
    if (name === "ul" || name === "ol") {
      const task = attrs["data-type"] === "taskList";
      return [
        {
          type: task ? "taskList" : name === "ol" ? "orderedList" : "bulletList",
          ...(name === "ol" ? { attrs: { start: Number(attrs.start) || 1 } } : {}),
          content: children().filter((n) => n.type === (task ? "taskItem" : "listItem")),
        },
      ];
    }
    if (name === "li") {
      const task = attrs["data-type"] === "taskItem";
      const content = blockNodes(children());
      return [
        {
          type: task ? "taskItem" : "listItem",
          ...(task ? { attrs: { checked: attrs["data-checked"] === "true" } } : {}),
          content: content.length ? content : [{ type: "paragraph" }],
        },
      ];
    }
    if (!["span", "div", "figure", "figcaption", "tbody", "thead", "tfoot"].includes(name))
      warn(`Unsupported HTML element '${name}' formatting was omitted.`);
    return children();
  };
  return parseDocument(html).children.flatMap((node) => visit(node));
}

/** HTML fallback for rich formatting that GFM cannot represent. Only known attributes are emitted. */
export function richNodeToHtml(node: RichNode, warnings: string[]): string {
  const attrs = node.attrs ?? {};
  const kids = () => (node.content ?? []).map((child) => richNodeToHtml(child, warnings)).join("");
  const attr = (key: string, value: unknown) =>
    value === undefined || value === null ? "" : ` ${key}="${escapeHtml(value)}"`;
  const wrap = (name: string, attributes = "") => `<${name}${attributes}>${kids()}</${name}>`;
  if (node.type === "text") {
    let text = escapeHtml(node.text);
    for (const mark of node.marks ?? []) {
      const a = mark.attrs ?? {};
      const tag = { bold: "strong", italic: "em", strike: "s", underline: "u", code: "code" }[
        mark.type
      ];
      if (tag) text = `<${tag}>${text}</${tag}>`;
      else if (mark.type === "link")
        text = `<a${attr("href", a.href)}${attr("title", a.title)}${attr("target", a.target)}${attr("rel", a.rel)}>${text}</a>`;
      else if (mark.type === "redacted") text = `<span data-ygdria-redacted>${text}</span>`;
      else if (mark.type === "highlight")
        text = `<mark${attr("style", styleValue(a.color) ? `background-color:${a.color}` : undefined)}>${text}</mark>`;
      else if (mark.type === "textStyle") {
        const style = [
          styleValue(a.color) ? `color:${a.color}` : "",
          styleValue(a.fontSize) ? `font-size:${a.fontSize}` : "",
        ]
          .filter(Boolean)
          .join(";");
        text = `<span${attr("style", style || undefined)}>${text}</span>`;
      } else warnings.push(`Unsupported mark '${mark.type}' formatting was omitted.`);
    }
    return text;
  }
  if (node.type === "noteReference")
    return `<span${attr("data-note-id", attrs.noteId)}${attr("data-note-title", attrs.title)}></span>`;
  if (node.type === "mathInline" || node.type === "mathBlock") {
    const tag = node.type === "mathInline" ? "span" : "div";
    return `<${tag} data-ygdria-math-${node.type === "mathInline" ? "inline" : "block"}${attr("data-formula", encodeURIComponent(attrs.formula ?? ""))}></${tag}>`;
  }
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "horizontalRule") return "<hr>";
  if (node.type === "image")
    return `<img${["src", "alt", "title", "width", "height"].map((key) => attr(key, attrs[key])).join("")}>`;
  if (node.type === "codeBlock")
    return `<pre><code${attr("class", attrs.language ? `language-${attrs.language}` : undefined)}${attr("data-language", attrs.language)}>${escapeHtml((node.content ?? []).map((n) => n.text ?? "").join(""))}</code></pre>`;
  if (node.type === "table")
    return wrap(
      "table",
      attr("data-colwidth", attrs.colwidth ? JSON.stringify(attrs.colwidth) : undefined),
    );
  if (["tableCell", "tableHeader"].includes(node.type))
    return wrap(
      node.type === "tableCell" ? "td" : "th",
      attr("colspan", attrs.colspan) +
        attr("rowspan", attrs.rowspan) +
        attr("data-colwidth", attrs.colwidth?.join(",")),
    );
  if (node.type === "orderedList") return wrap("ol", attr("start", attrs.start));
  if (node.type === "taskList") return wrap("ul", ' data-type="taskList"');
  if (node.type === "taskItem")
    return wrap("li", ` data-type="taskItem" data-checked="${Boolean(attrs.checked)}"`);
  const tag = {
    paragraph: "p",
    heading: `h${attrs.level || 1}`,
    bulletList: "ul",
    listItem: "li",
    blockquote: "blockquote",
    tableRow: "tr",
  }[node.type];
  if (tag)
    return wrap(tag, attr("style", attrs.textAlign ? `text-align:${attrs.textAlign}` : undefined));
  warnings.push(`Unsupported node '${node.type}' formatting was omitted.`);
  return kids();
}
