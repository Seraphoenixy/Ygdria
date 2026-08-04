import { describe, it, expect } from "vitest";
import { appendTiptapDocument, markdownToTiptap, tiptapToMarkdown } from "./markdown.js";
describe("Markdown conversion", () => {
  it("keeps note references", () => {
    const d = markdownToTiptap("See [[note:abc|RAIM]]").document;
    expect(JSON.stringify(d)).toContain("noteReference");
    expect(tiptapToMarkdown(d).markdown).toContain("[[note:abc|RAIM]]");
  });
  it("round-trips redacted text through Markdown source", () => {
    const source = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret", marks: [{ type: "redacted" }] }] }] } as any;
    const markdown = tiptapToMarkdown(source).markdown;
    expect(markdown).toContain("data-ygdria-redacted");
    expect(markdownToTiptap(markdown).document).toMatchObject({ content: [{ content: [{ text: "secret", marks: [{ type: "redacted" }] }] }] });
  });
  it("parses a GFM table", () =>
    expect(JSON.stringify(markdownToTiptap("| A | B |\n| - | - |\n| 1 | 2 |").document)).toContain(
      "table",
    ));
  it("round-trips tables through Markdown source", () => {
    const document = markdownToTiptap("| A | B |\n| --- | --- |\n| 1 | 2 |").document;
    const markdown = tiptapToMarkdown(document).markdown;

    expect(markdown).toContain("| --- | --- |");
    expect((markdownToTiptap(markdown).document.content?.[0] as any)?.type).toBe("table");
  });
  it("converts standard inline formatting and Trilium image HTML", () => {
    const document = markdownToTiptap("**bold** and *italic* with [link](https://example.com)\n\n<figure><img src=\"/image.png\"></figure>").document;
    const json = JSON.stringify(document);
    expect(json).toContain('"bold"');
    expect(json).toContain('"italic"');
    expect(json).toContain('"link"');
    expect(json).toContain('"image"');
  });
  it("converts HTML tables and preserves their cell text", () => {
    const document = markdownToTiptap("<table><tr><th>Header</th></tr><tr><td>Value</td></tr></table>").document;
    expect((document.content?.[0] as any)?.type).toBe("table");
    expect(JSON.stringify(document)).toContain("Header");
    expect(JSON.stringify(document)).toContain("Value");
  });
  it("recognizes inline and block LaTeX formulas", () => {
    const document = markdownToTiptap("Energy is $E = mc^2$.\n\n$$\n\\frac{a}{b}\n$$").document;
    const json = JSON.stringify(document);
    expect(json).toContain("mathInline");
    expect(json).toContain("mathBlock");
    expect(tiptapToMarkdown(document).markdown).toContain("$E = mc^2$");
    expect(tiptapToMarkdown(document).markdown).toContain("\\frac{a}{b}");
  });
  it("recognizes MathJax-style bracketed display formulas", () => {
    const document = markdownToTiptap("\\[\n\\text{Destination: 1.0.1.100} \\xrightarrow{\\text{WFP 内核还原}} \\text{Destination: 10.20.112.77}\n\\]").document;

    expect(document.content?.[0]).toMatchObject({
      type: "mathBlock",
      attrs: { formula: "\\text{Destination: 1.0.1.100} \\xrightarrow{\\text{WFP 内核还原}} \\text{Destination: 10.20.112.77}" },
    });
  });
  it("keeps LaTeX commands in a single inline formula instead of splitting escape tokens", () => {
    const document = markdownToTiptap("公式为 $\\pm m \\times 2^{\\exp}$，其中“$m$”由尾数推导。").document;
    const nodes = (document.content?.[0] as any)?.content ?? [];
    expect(nodes.filter((node: any) => node.type === "mathInline").map((node: any) => node.attrs.formula)).toEqual([
      "\\pm m \\times 2^{\\exp}",
      "m",
    ]);
  });
  it("warns when complex tables downgrade", () => {
    const r = tiptapToMarkdown({
      type: "doc",
      content: [{ type: "table", attrs: { colwidth: [100] }, content: [] }],
    });
    expect(r.warnings.length).toBe(1);
  });
  it("keeps fenced code block languages through a round trip", () => {
    const document = markdownToTiptap("```typescript\nconst value: number = 1;\n```").document;
    const codeBlock = document.content?.find((node: any) => node.type === "codeBlock") as any;

    expect(codeBlock?.attrs?.language).toBe("typescript");
    expect(tiptapToMarkdown(document).markdown).toContain("```typescript");
  });
  it("removes blank lines immediately before a closing code fence", () => {
    const document = markdownToTiptap("```typescript\nconst value = 1;\n\n```").document;
    const codeBlock = document.content?.find((node: any) => node.type === "codeBlock") as any;

    expect(codeBlock?.content?.[0]?.text).toBe("const value = 1;");
  });
  it("appends imported Markdown without replacing the existing document", () => {
    const existing = markdownToTiptap("# Existing\n\nKeep this paragraph.").document;
    const imported = markdownToTiptap("## Imported\n\nAdd this paragraph.").document;

    const combined = appendTiptapDocument(existing, imported);

    expect(combined.content).toHaveLength((existing.content?.length ?? 0) + (imported.content?.length ?? 0));
    expect(tiptapToMarkdown(combined).markdown).toContain("# Existing");
    expect(tiptapToMarkdown(combined).markdown).toContain("## Imported");
  });
  it("preserves unsupported Markdown tokens as visible text", () => {
    const { document, warnings } = markdownToTiptap("[shortcut]: https://example.com");

    expect(JSON.stringify(document)).toContain("shortcut");
    expect(warnings.some((warning) => warning.includes("Unsupported Markdown token"))).toBe(true);
  });
});
