import { describe, expect, it } from "vitest";
import { decodeStoredContent, encodeDocumentContent } from "./content-codec.js";

describe("note content codec", () => {
  it("keeps documents below 2KB uncompressed", () => {
    const content = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "short" }] }] });
    const stored = encodeDocumentContent(content);
    expect(stored.codec).toBe("identity");
    expect(stored.size).toBe(Buffer.byteLength(content));
    expect(decodeStoredContent(stored.data, stored.codec)).toBe(content);
  });

  it("compresses repetitive documents at or above 2KB and decodes losslessly", () => {
    const content = JSON.stringify({ type: "doc", content: Array.from({ length: 80 }, () => ({ type: "paragraph", content: [{ type: "text", text: "repeated TipTap JSON structure " }] })) });
    const stored = encodeDocumentContent(content);
    expect(Buffer.byteLength(content)).toBeGreaterThanOrEqual(2 * 1024);
    expect(stored.codec).toBe("zstd-v1");
    expect(stored.data.byteLength).toBeLessThan(stored.size);
    expect(decodeStoredContent(stored.data, stored.codec)).toBe(content);
  });
});
