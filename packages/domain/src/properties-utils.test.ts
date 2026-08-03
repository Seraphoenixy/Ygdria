import { describe, expect, it } from "vitest";
import {
  parseProperties,
  normalizeTags,
  serializeProperties,
  codeProperties,
  tagsProperties,
  readCodeLanguage,
  readTags,
} from "./properties-utils.js";

describe("parseProperties", () => {
  it("degrades invalid JSON to empty object", () => {
    expect(parseProperties("")).toEqual({});
    expect(parseProperties("{")).toEqual({});
    expect(parseProperties("null")).toEqual({});
    expect(parseProperties("[]")).toEqual({});
    expect(parseProperties('"string"')).toEqual({});
    expect(parseProperties("42")).toEqual({});
  });

  it("parses valid JSON with known fields", () => {
    expect(parseProperties('{"codeLanguage":"typescript"}')).toEqual({ codeLanguage: "typescript" });
    expect(parseProperties('{"tags":["work"]}')).toEqual({ tags: ["work"] });
    expect(parseProperties('{"codeLanguage":"ts","tags":["a","b"]}')).toEqual({ codeLanguage: "ts", tags: ["a", "b"] });
  });

  it("preserves unknown fields for forward compatibility", () => {
    const result = parseProperties('{"futureField":true,"codeLanguage":"go"}');
    expect(result).toHaveProperty("futureField", true);
    expect(result).toHaveProperty("codeLanguage", "go");
  });

  it("returns empty object for empty JSON object", () => {
    expect(parseProperties("{}")).toEqual({});
  });
});

describe("normalizeTags", () => {
  it("trims each tag", () => {
    expect(normalizeTags(["  work  ", " fun "])).toEqual(["work", "fun"]);
  });

  it("filters empty and blank tags", () => {
    expect(normalizeTags(["", "  ", "work"])).toEqual(["work"]);
    expect(normalizeTags(["", "  "])).toBeUndefined();
  });

  it("deduplicates tags", () => {
    expect(normalizeTags(["work", "work", "fun"])).toEqual(["work", "fun"]);
  });

  it("returns undefined for non-array input", () => {
    expect(normalizeTags("string")).toBeUndefined();
    expect(normalizeTags(null)).toBeUndefined();
    expect(normalizeTags(undefined)).toBeUndefined();
    expect(normalizeTags({})).toBeUndefined();
  });

  it("enforces per-item max length", () => {
    const longTag = "a".repeat(65);
    expect(normalizeTags([longTag, "ok"])).toEqual(["ok"]);
  });

  it("enforces max count", () => {
    const manyTags = Array.from({ length: 25 }, (_, i) => `tag${i}`);
    const result = normalizeTags(manyTags);
    expect(result).toHaveLength(20);
    expect(result![0]).toBe("tag0");
    expect(result![19]).toBe("tag19");
  });
});

describe("serializeProperties", () => {
  it("strips undefined values", () => {
    expect(serializeProperties({ codeLanguage: undefined })).toBe("{}");
  });

  it("omits empty tags array", () => {
    expect(serializeProperties({ tags: [] })).toBe("{}");
  });

  it("serializes valid properties", () => {
    expect(serializeProperties({ codeLanguage: "ts", tags: ["a"] })).toBe('{"codeLanguage":"ts","tags":["a"]}');
  });
});

describe("tagsProperties", () => {
  it("preserves existing tags when tags is undefined", () => {
    const existing = '{"tags":["work","fun"]}';
    expect(tagsProperties(undefined, existing)).toBe('{"tags":["work","fun"]}');
  });

  it("preserves existing codeLanguage when setting tags", () => {
    const existing = '{"codeLanguage":"typescript"}';
    expect(tagsProperties(["work"], existing)).toBe('{"codeLanguage":"typescript","tags":["work"]}');
  });

  it("clears tags when empty array is passed", () => {
    const existing = '{"tags":["old"]}';
    expect(tagsProperties([], existing)).toBe("{}");
  });

  it("returns empty object when no existing and no tags", () => {
    expect(tagsProperties(undefined)).toBe("{}");
    expect(tagsProperties([])).toBe("{}");
  });
});

describe("codeProperties", () => {
  it("sets codeLanguage and preserves existing tags", () => {
    const existing = '{"tags":["work"]}';
    expect(codeProperties("typescript", existing)).toBe('{"tags":["work"],"codeLanguage":"typescript"}');
  });

  it("works with no existing properties", () => {
    expect(codeProperties("python")).toBe('{"codeLanguage":"python"}');
  });

  it("replaces existing codeLanguage", () => {
    const existing = '{"codeLanguage":"javascript"}';
    expect(codeProperties("typescript", existing)).toBe('{"codeLanguage":"typescript"}');
  });
});

describe("readCodeLanguage", () => {
  it("returns valid codeLanguage", () => {
    expect(readCodeLanguage('{"codeLanguage":"typescript"}')).toBe("typescript");
  });

  it("defaults to plaintext for missing codeLanguage", () => {
    expect(readCodeLanguage("{}")).toBe("plaintext");
  });

  it("defaults to plaintext for invalid JSON", () => {
    expect(readCodeLanguage("{")).toBe("plaintext");
  });
});

describe("readTags", () => {
  it("returns tags array", () => {
    expect(readTags('{"tags":["a","b"]}')).toEqual(["a", "b"]);
  });

  it("returns empty array for missing tags", () => {
    expect(readTags("{}")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(readTags("{")).toEqual([]);
  });
});