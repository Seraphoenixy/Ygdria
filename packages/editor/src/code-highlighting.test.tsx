import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NoteContent } from "@ygdria/shared";
import {
  MAX_HIGHLIGHTED_CODE_BYTES,
  highlightCode,
  normalizeCodeLanguage,
} from "./code-highlighting.js";
import { StaticDocument } from "./renderer.js";

describe("code highlighting", () => {
  it("highlights registered languages and normalizes common aliases", () => {
    const result = highlightCode("const answer: number = 42;", "ts");

    expect(normalizeCodeLanguage("ts")).toBe("typescript");
    expect(normalizeCodeLanguage("jsx")).toBe("javascript");
    expect(normalizeCodeLanguage("tsx")).toBe("typescript");
    expect(result.highlighted).toBe(true);
    expect(JSON.stringify(result.tree)).toContain("hljs-keyword");
  });

  it("falls back to escaped plain text for unknown languages", () => {
    const document: NoteContent = {
      type: "doc",
      content: [{
        type: "codeBlock",
        attrs: { language: "unknown-language" },
        content: [{ type: "text", text: "<script>alert('x')</script>" }],
      }],
    };
    const markup = renderToStaticMarkup(<StaticDocument document={document} />);

    expect(highlightCode("hello", "unknown-language").highlighted).toBe(false);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });

  it("does not highlight code blocks larger than 100 KiB", () => {
    const result = highlightCode("x".repeat(MAX_HIGHLIGHTED_CODE_BYTES + 1), "javascript");

    expect(result.tooLarge).toBe(true);
    expect(result.highlighted).toBe(false);
  });

  it("renders language metadata, copy control, and token classes", () => {
    const document: NoteContent = {
      type: "doc",
      content: [{
        type: "codeBlock",
        attrs: { language: "javascript" },
        content: [{ type: "text", text: "const value = true;" }],
      }],
    };
    const markup = renderToStaticMarkup(<StaticDocument document={document} />);

    expect(markup).toContain('data-language="javascript"');
    expect(markup).toContain("Copy code");
    expect(markup).toContain("hljs-keyword");
  });
});
