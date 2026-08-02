import { describe, it, expect } from "vitest";
import { buildSearchRegex, computeMatches, escapeRegex } from "./search-replace.js";

// A minimal stand-in for a ProseMirror doc: a single text node at offset 0.
function fakeDoc(text: string) {
  return {
    descendants(cb: (node: any, pos: number) => void) {
      cb({ isText: true, text }, 0);
    },
  };
}

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
  });
});

describe("buildSearchRegex", () => {
  it("is case-insensitive by default", () => {
    const re = buildSearchRegex("hello", { caseSensitive: false, wholeWord: false });
    expect(re.test("HELLO")).toBe(true);
  });

  it("respects case sensitivity", () => {
    const re = buildSearchRegex("hello", { caseSensitive: true, wholeWord: false });
    expect(re.test("HELLO")).toBe(false);
    expect(re.test("hello")).toBe(true);
  });

  it("whole-word matching excludes partial overlaps", () => {
    const re = buildSearchRegex("cat", { caseSensitive: false, wholeWord: true });
    expect(re.test("cat")).toBe(true);
    expect(re.test("category")).toBe(false);
    expect(re.test("a cat sat")).toBe(true);
  });

  it("treats CJK characters as word units", () => {
    const re = buildSearchRegex("苹果", { caseSensitive: false, wholeWord: true });
    expect(re.test("苹果")).toBe(true);
    expect(re.test("红苹果")).toBe(false);
  });
});

describe("computeMatches", () => {
  it("returns all occurrences with correct offsets", () => {
    const matches = computeMatches(fakeDoc("hello world hello"), "hello", {
      caseSensitive: false,
      wholeWord: false,
    });
    expect(matches).toEqual([
      { from: 0, to: 5 },
      { from: 12, to: 17 },
    ]);
  });

  it("returns no matches for an empty term", () => {
    expect(computeMatches(fakeDoc("hello"), "", { caseSensitive: false, wholeWord: false })).toEqual([]);
  });
});
