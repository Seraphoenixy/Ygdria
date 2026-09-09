import { describe, expect, it } from "vitest";
import { markdownDownloadFilename } from "./useNoteTransfer";

describe("Markdown export filename", () => {
  it("uses the note title", () => {
    expect(markdownDownloadFilename("我的笔记")).toBe("我的笔记.md");
  });

  it("removes filename path separators and falls back for empty titles", () => {
    expect(markdownDownloadFilename("draft:/today?")).toBe("draft__today_.md");
    expect(markdownDownloadFilename("... ")).toBe("ygdria-notes.md");
  });
});
