import { describe, expect, it } from "vitest";
import { buildHunks, lcsDiff, linesFromContent } from "./DiffView.js";

function doc(...paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) =>
      text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" },
    ),
  };
}

describe("linesFromContent", () => {
  it("keeps one line per visual line for a string (code notes)", () => {
    expect(linesFromContent("a\nb")).toEqual(["a", "b"]);
  });

  it("returns no lines for absent content", () => {
    expect(linesFromContent(undefined)).toEqual([]);
    expect(linesFromContent(null)).toEqual([]);
  });

  it("joins inline text nodes of one paragraph into a single line", () => {
    const rich = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", marks: [{ type: "bold" }], text: "world" },
          ],
        },
      ],
    };
    expect(linesFromContent(rich)).toEqual(["Hello **world**"]);
  });

  it("splits code blocks and hard breaks into real lines", () => {
    const rich = {
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }] },
        { type: "paragraph", content: [{ type: "text", text: "行1" }, { type: "hardBreak" }, { type: "text", text: "行2" }] },
      ],
    };
    const lines = linesFromContent(rich);
    expect(lines).toContain("const a = 1;");
    expect(lines).toContain("const b = 2;");
    expect(lines).toContain("行1");
    expect(lines).toContain("行2");
  });

  it("separates paragraphs so an inline edit does not swallow the block boundary", () => {
    const before = doc("first", "second");
    const after = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }, { type: "hardBreak" }, { type: "text", text: "second" }] },
      ],
    };
    expect(linesFromContent(before)).toEqual(["first", "", "second"]);
    expect(linesFromContent(after)).toEqual(["first", "second"]);
  });

  it("renders empty paragraphs as empty diff lines, not HTML fallbacks", () => {
    expect(linesFromContent(doc("above", "", "below"))).toEqual(["above", "", "", "", "below"]);
  });
});

describe("lcsDiff + buildHunks", () => {
  it("produces one replacement hunk for a changed line", () => {
    const ops = lcsDiff(["a", "b", "c"], ["a", "B", "c"]);
    expect(ops).toEqual([
      { type: "equal", text: "a" },
      { type: "delete", text: "b" },
      { type: "insert", text: "B" },
      { type: "equal", text: "c" },
    ]);
    const hunks = buildHunks(ops);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].lines.map((line) => line.type)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
  });

  it("returns no hunks for identical content", () => {
    expect(buildHunks(lcsDiff(["a"], ["a"]))).toHaveLength(0);
  });
});
