import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "./frontMatter.js";

describe("parseFrontMatter", () => {
  it("returns the input untouched when no fence is present", () => {
    const markdown = "# Heading\n\nbody";
    expect(parseFrontMatter(markdown)).toEqual({
      data: { tags: [], unmappedKeys: [] },
      body: markdown,
    });
  });

  it("does not treat a mid-document fence as front matter", () => {
    const markdown = "intro\n\n---\ntitle: fake\n---\n";
    expect(parseFrontMatter(markdown).body).toBe(markdown);
  });

  it("extracts title, comma tags and reports unmapped keys", () => {
    const { data, body } = parseFrontMatter(
      "---\ntitle: My Note\ntags: a, b\ncustom: x\n---\n\nbody",
    );
    expect(data.title).toBe("My Note");
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.unmappedKeys).toEqual(["custom"]);
    expect(body).toBe("\nbody");
  });

  it("parses inline array tags and quoted values", () => {
    const { data } = parseFrontMatter('---\ntitle: "Quoted: with colon"\ntags: ["x, y", z]\n---\n');
    expect(data.title).toBe("Quoted: with colon");
    expect(data.tags).toEqual(["x, y", "z"]);
  });

  it("parses a YAML block list of tags", () => {
    const { data, body } = parseFrontMatter("---\ntags:\n  - one\n  - two\n---\nbody");
    expect(data.tags).toEqual(["one", "two"]);
    expect(body).toBe("body");
  });

  it("handles CRLF and a BOM, which the server fence regex misses", () => {
    const { data, body } = parseFrontMatter("\uFEFF---\r\ntitle: Win\r\ntags: t1,t2\r\n---\r\n\r\nbody\r\n");
    expect(data.title).toBe("Win");
    expect(data.tags).toEqual(["t1", "t2"]);
    expect(body).toBe("\r\nbody\r\n");
  });

  it("ignores comments and blank lines inside the fence", () => {
    const { data } = parseFrontMatter("---\n# comment\n\ntags: a\n---\n");
    expect(data.tags).toEqual(["a"]);
    expect(data.unmappedKeys).toEqual([]);
  });
});
