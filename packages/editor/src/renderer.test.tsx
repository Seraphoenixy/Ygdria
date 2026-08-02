import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NoteContent } from "@ygdria/shared";
import { StaticDocument } from "./renderer.js";

function tableDocument(colwidths: (number | null)[][]): NoteContent {
  return {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colspan: 1, rowspan: 1, colwidth: colwidths[0] ?? null },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
              },
              {
                type: "tableHeader",
                attrs: { colspan: 1, rowspan: 1, colwidth: colwidths[1] ?? null },
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: colwidths[0] ?? null },
                content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
              },
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: colwidths[1] ?? null },
                content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("static table rendering", () => {
  it("renders a <colgroup> from the first row's colwidth attributes", () => {
    const markup = renderToStaticMarkup(
      <StaticDocument document={tableDocument([[120], [240]])} />,
    );

    expect(markup).toContain("<colgroup>");
    expect(markup).toContain('style="width:120px"');
    expect(markup).toContain('style="width:240px"');
  });

  it("omits the <colgroup> when no column has a width", () => {
    const markup = renderToStaticMarkup(<StaticDocument document={tableDocument([[null], [null]])} />);

    expect(markup).not.toContain("<colgroup>");
  });

  it("never pins an inline width on the <table> element itself", () => {
    // Column widths are expressed only through the <colgroup>. The <table>
    // stays width:100% via CSS, matching the editable view (where Tiptap's
    // TableView is forced back to a fluid width). Pinning an inline width
    // here would make static and editable views diverge.
    const markup = renderToStaticMarkup(
      <StaticDocument document={tableDocument([[120], [240]])} />,
    );

    expect(markup).toContain("<table>");
    expect(markup).not.toMatch(/<table[^>]*style=/);
  });

  it("expands a merged cell's colwidth across its colspan", () => {
    const document: NoteContent = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2, rowspan: 1, colwidth: [80, 160] },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Merged" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: [80] },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
                },
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: [160] },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "y" }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(<StaticDocument document={document} />);

    expect(markup).toContain('style="width:80px"');
    expect(markup).toContain('style="width:160px"');
  });
});
