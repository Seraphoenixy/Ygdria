import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildMarkdownExportArchive, markdownDownloadFilename } from "./useNoteTransfer";

describe("Markdown export filename", () => {
  it("uses the note title", () => {
    expect(markdownDownloadFilename("我的笔记")).toBe("我的笔记.md");
  });

  it("removes filename path separators and falls back for empty titles", () => {
    expect(markdownDownloadFilename("draft:/today?")).toBe("draft__today_.md");
    expect(markdownDownloadFilename("... ")).toBe("ygdria-notes.md");
  });
});

describe("Markdown multi-note export", () => {
  it("keeps multiple notes and their hierarchy in a ZIP archive", async () => {
    const archive = buildMarkdownExportArchive([
      { sourcePlacementId: "root", parentSourceId: null, title: "Root", markdown: "root body" },
      { sourcePlacementId: "child", parentSourceId: "root", title: "Child", markdown: "child body" },
    ]);
    const files = unzipSync(archive);
    const decoder = new TextDecoder();
    const manifest = JSON.parse(decoder.decode(files["!!!meta.json"])) as {
      files: Array<{ title: string; dataFileName: string; dirFileName?: string; children?: Array<{ title: string; dataFileName: string }> }>;
    };

    expect(decoder.decode(files["Root.md"])).toBe("root body");
    expect(decoder.decode(files["Root/Child.md"])).toBe("child body");
    expect(manifest.files[0]).toMatchObject({
      title: "Root",
      dataFileName: "Root.md",
      dirFileName: "Root",
      children: [{ title: "Child", dataFileName: "Child.md" }],
    });
  });
});
