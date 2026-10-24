import { describe, expect, it } from "vitest";
import { markdownToTiptap, tiptapToMarkdown } from "./markdown.js";
import type { RichNode } from "./markdown-html.js";

const doc = (...content: RichNode[]): RichNode => ({ type: "doc", content });
const text = (value: string, marks?: RichNode["marks"]): RichNode => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const p = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
const roundTrip = (node: RichNode) => markdownToTiptap(tiptapToMarkdown(node).markdown).document;
const all = (node: any): RichNode[] => [node, ...(node.content ?? []).flatMap(all)];
const nodes = (node: any, type: string) => all(node).filter((n) => n.type === type);
// Tiptap applies default attrs and canonicalizes mark order; compare semantics.
const canonical = (node: any): any => {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {}).filter(([, value]) => value != null),
  );
  return {
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(node.marks?.length
      ? {
          marks: node.marks
            .map((m: any) => canonical(m))
            .sort((a: any, b: any) => a.type.localeCompare(b.type)),
        }
      : {}),
    ...(node.content?.length ? { content: node.content.map(canonical) } : {}),
  };
};

describe("Markdown semantic fidelity", () => {
  it.each([
    ["https://example.com/a_(b)?q=1&next=%20#part", 'A "quoted" title'],
    ["https://example.com/a b?q=<value>", "space in URL"],
    ["mailto:test@example.com", null],
    ["../assets/file.pdf#page=3", null],
  ])("keeps link targets, titles and literal labels: %s", (href, title) => {
    const source = doc(p(text("[官方] *下载* & 驱动", [{ type: "link", attrs: { href, title } }])));
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it.each(["bold", "italic", "strike", "code", "underline", "redacted"])(
    "keeps %s marks",
    (type) => {
      const source = doc(
        p(text("before "), text("中文 & <tag> `value`", [{ type }]), text(" after")),
      );
      expect(canonical(roundTrip(source))).toEqual(canonical(source));
    },
  );

  it("keeps overlapping marks, whitespace, highlights and text styles", () => {
    const source = doc(
      p(
        text(" bold italic ", [{ type: "bold" }, { type: "italic" }]),
        text("link", [
          { type: "bold" },
          { type: "link", attrs: { href: "https://example.com/?a=1&b=2", title: "title" } },
        ]),
        text("字色字号", [
          { type: "textStyle", attrs: { color: "var(--editor-text-2)", fontSize: "18px" } },
        ]),
        text("高亮", [{ type: "highlight", attrs: { color: "#ffee00" } }]),
      ),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("does not join adjacent emphasis markers into a different mark", () => {
    const source = doc(
      p(
        text("first", [{ type: "bold" }]),
        text("second", [{ type: "italic" }]),
        text("third", [{ type: "strike" }]),
      ),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("does not interpret literal Markdown, formulas, HTML or references", () => {
    const source = doc(
      p(
        text(
          "# heading\n1. list\n- item\n**literal** [label](url) $price$ [[note:abc|literal]] <b>x</b> &amp;",
        ),
      ),
    );
    const result = roundTrip(source);
    expect(
      nodes(result, "text")
        .map((n) => n.text)
        .join(""),
    ).toBe(source.content![0].content![0].text);
    expect(nodes(result, "noteReference")).toHaveLength(0);
    expect(nodes(result, "mathInline")).toHaveLength(0);
    expect(nodes(result, "text").every((n) => !n.marks?.length)).toBe(true);
  });

  it("keeps code literal, including formulas, references and nested fences", () => {
    const code =
      "const value = `$x$ [[note:abc|literal]]`;\n```\n<span data-ygdria-redacted>literal</span>";
    const source = doc({
      type: "codeBlock",
      attrs: { language: "javascript" },
      content: [text(code)],
    });
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
    expect(
      nodes(markdownToTiptap("`$x$ [[note:abc|literal]]`\\n").document, "mathInline"),
    ).toHaveLength(0);
  });

  it("keeps significant trailing code newlines and inline backticks", () => {
    const source = doc(
      { type: "codeBlock", attrs: { language: "text" }, content: [text("line\n\n")] },
      p(text("`x` and ``y``", [{ type: "code" }])),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("keeps task states, nested lists, multiple paragraphs and ordered starts", () => {
    const document = markdownToTiptap(
      "- [x] done\n  - nested\n- [ ] pending\n\n7. seven\n\n   second paragraph\n\n8. eight",
    ).document;
    const result = roundTrip(document as RichNode);
    expect(canonical(result)).toEqual(canonical(document));
    expect(nodes(result, "taskItem").map((n) => n.attrs?.checked)).toEqual([true, false]);
    expect(nodes(result, "orderedList")[0].attrs?.start).toBe(7);
  });

  it("keeps blockquotes, explicit line breaks and horizontal rules", () => {
    const document = markdownToTiptap(
      "> quoted **bold**\n>\n> - nested\n\nfirst  \nsecond\n\n---\n\nlast",
    ).document;
    expect(canonical(roundTrip(document as RichNode))).toEqual(canonical(document));
  });

  it("keeps merged cells, column widths and rich cell content in real HTML", () => {
    const source = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2, rowspan: 1, colwidth: [120, 180] },
              content: [p(text("header", [{ type: "bold" }]))],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { rowspan: 2 },
              content: [
                p(text("left | right")),
                p(text("second", [{ type: "link", attrs: { href: "https://example.com" } }])),
              ],
            },
            { type: "tableCell", content: [p(text("cell"))] },
          ],
        },
      ],
    });
    const exported = tiptapToMarkdown(source);
    expect(exported.markdown).toContain('<th colspan="2"');
    expect(exported.markdown).toContain('data-colwidth="120,180"');
    expect(canonical(markdownToTiptap(exported.markdown).document)).toEqual(canonical(source));
  });

  it("keeps simple table pipes, inline code and line breaks", () => {
    const source = doc({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [p(text("header"))] }] },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [p(text("a | b"), { type: "hardBreak" }, text("x | y", [{ type: "code" }]))],
            },
          ],
        },
      ],
    });
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("keeps images with titles and dimensions along with neighboring text", () => {
    const source = doc(
      p(text("before")),
      {
        type: "image",
        attrs: {
          src: "/api/v1/attachments/abc",
          alt: "[a] & b",
          title: "title",
          width: 320,
          height: 200,
        },
      },
      p(text("after")),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
    const imported = markdownToTiptap('before ![image](/image.png "title") after').document;
    expect(nodes(imported, "image")[0].attrs?.title).toBe("title");
    expect(
      nodes(imported, "text")
        .map((n) => n.text)
        .join(""),
    ).toBe("before  after");
  });

  it("keeps paragraph alignment and reference titles containing delimiters", () => {
    const source = doc(
      { ...p(text("aligned")), attrs: { textAlign: "center" } },
      p({ type: "noteReference", attrs: { noteId: "abc", title: "a ] b & c" } }),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("keeps empty paragraphs and significant paragraph whitespace", () => {
    const source = doc(p(), p(text("  leading and trailing  ")), p());
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("does not end HTML fallbacks at blank lines inside styled text", () => {
    const source = doc(
      p(
        text("first\n\n/** Public logger **/\n\n[not a link](url) $literal$", [
          { type: "underline" },
        ]),
      ),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("does not autolink URLs inside literal source code paragraphs", () => {
    const source = doc(
      p(
        text(
          'const html = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">`;',
        ),
      ),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("keeps explicit link opening behavior", () => {
    const source = doc(
      p(
        text("link", [
          {
            type: "link",
            attrs: { href: "https://example.com", target: "_self", rel: "nofollow" },
          },
        ]),
      ),
    );
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("keeps multiline text indentation and native CRLF code", () => {
    const source = doc(p(text("function run() {\n    work();\n  }")), {
      type: "codeBlock",
      attrs: { language: "sh" },
      content: [text("first\r\nsecond")],
    });
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("keeps whitespace next to images in legacy inline-image paragraphs", () => {
    const source = doc(
      p(
        text(" \u00a0"),
        { type: "image", attrs: { src: "/image.png", alt: "", title: null } },
        text("caption"),
      ),
    );
    const result = roundTrip(source);
    expect(
      nodes(result, "text")
        .map((n) => n.text)
        .join(""),
    ).toBe(" \u00a0caption");
    expect(nodes(result, "image")).toHaveLength(1);
  });

  it("keeps literal bracketed text and reserved embeds out of math and references", () => {
    const source = doc(p(text("[literal]")));
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
    const imported = markdownToTiptap("![[note:abc|reserved embed]]").document;
    expect(nodes(imported, "noteReference")).toHaveLength(0);
    expect(
      nodes(imported, "text")
        .map((n) => n.text)
        .join(""),
    ).toBe("![[note:abc|reserved embed]]");
  });

  it("preserves table headers and alignment without inventing headers", () => {
    const imported = markdownToTiptap("| A | B |\n| :--- | ---: |\n| a | b |").document;
    expect(canonical(roundTrip(imported as RichNode))).toEqual(canonical(imported));
    const source = doc({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableCell", content: [p(text("not a header"))] }] },
      ],
    });
    expect(nodes(roundTrip(source), "tableHeader")).toHaveLength(0);
    expect(canonical(roundTrip(source))).toEqual(canonical(source));
  });

  it("reports unknown formatting and never imports executable HTML attributes", () => {
    const imported = markdownToTiptap(
      '<p onclick="alert(1)"><a href="javascript:alert(1)">keep text</a><img src="javascript:alert(1)" onerror="alert(1)" alt="image"></p>',
    );
    expect(JSON.stringify(imported.document)).not.toMatch(/onclick|onerror|javascript:/);
    expect(imported.warnings.length).toBeGreaterThan(0);
    const exported = tiptapToMarkdown(doc(p(text("visible", [{ type: "unknownMark" }]))));
    expect(exported.markdown).toContain("visible");
    expect(exported.warnings.join(" ")).toContain("unknownMark");
  });
});
