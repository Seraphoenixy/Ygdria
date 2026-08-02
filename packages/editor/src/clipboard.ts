import DOMPurify from "dompurify";
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
