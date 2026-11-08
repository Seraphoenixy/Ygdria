import DOMPurify from "dompurify";
import { DOMParser as ProseMirrorDOMParser, type Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/** Empty paragraphs are not a successful paste; keep non-text content such as tables. */
export function hasPastedContent(slice: Slice): boolean {
  let usable = false;
  slice.content.descendants((node) => {
    if (node.isText && node.text?.trim().length) usable = true;
    else if (node.type.name === "image") usable ||= Boolean(node.attrs.src);
    else if (!node.isText && (node.type.name === "table" || (node.isAtom && !node.isTextblock))) usable = true;
    return !usable;
  });
  return usable;
}

/** Context-menu paste uses the same parser and literal text path as native paste. */
export function pasteClipboardHtml(view: EditorView, html: string): boolean {
  const container = document.createElement("div");
  container.innerHTML = normalizePastedHtml(html);
  const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(container);
  if (!hasPastedContent(slice)) return false;
  // pasteHTML runs transformPastedHTML itself. Pass the original fragment so
  // normalization does not strip or restructure the same content twice.
  return view.pasteHTML(html);
}
/** Browser-side, testable Word/Office HTML cleanup.  It deliberately retains structure, never Office presentation. */
export function normalizePastedHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "s",
      "del",
      "a",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "img",
      "span",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "colspan", "rowspan"],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  doc.querySelectorAll("*").forEach((el) => {
    const wordHeading = /\bMso(?:Title|Heading)/.test(el.className);
    el.removeAttribute("style");
    el.removeAttribute("class");
    if (wordHeading && el.tagName === "P") {
      const h = doc.createElement("h2");
      h.textContent = el.textContent;
      el.replaceWith(h);
    }
  });
  // Word headings often arrive as styled paragraphs after sanitization; normalize known semantic markers first.
  doc
    .querySelectorAll("p[data-level='heading']")
    .forEach((p) =>
      p.replaceWith(Object.assign(doc.createElement("h2"), { textContent: p.textContent })),
    );
  return doc.body.innerHTML.replace(/<o:p[^>]*>[\s\S]*?<\/o:p>/gi, "");
}
