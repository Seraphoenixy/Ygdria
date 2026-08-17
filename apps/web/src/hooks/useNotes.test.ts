import { describe, it, expect } from "vitest";
import { isSameDiffContent } from "./useNotes.js";

function doc(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : undefined,
      },
    ],
  };
}

describe("isSameDiffContent", () => {
  it("treats identical rich-text documents as equal", () => {
    expect(isSameDiffContent(doc("hello"), doc("hello"))).toBe(true);
  });

  it("detects differing rich-text documents", () => {
    expect(isSameDiffContent(doc("hello"), doc("world"))).toBe(false);
  });

  it("treats identical code strings as equal", () => {
    expect(isSameDiffContent("a\nb", "a\nb")).toBe(true);
    expect(isSameDiffContent("a\nb", "a\nc")).toBe(false);
  });

  it("treats two empty bodies as equal", () => {
    expect(isSameDiffContent(doc(""), doc(""))).toBe(true);
    expect(isSameDiffContent(undefined, undefined)).toBe(true);
  });

  it("does not compare a document against a raw string of the same text", () => {
    // The document flattening appends a trailing newline per block, so the
    // shapes differ; real conflicts always compare matching shapes.
    expect(isSameDiffContent(doc("abc"), "abc")).toBe(false);
  });
});
