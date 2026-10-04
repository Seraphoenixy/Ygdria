import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildMarkdownExportArchive, markdownArchiveFilename, markdownDownloadFilename } from "./useNoteTransfer";

describe("Markdown export filename", () => {
  it("uses the note title", () => {
    expect(markdownDownloadFilename("我的笔记")).toBe("我的笔记.md");
  });

  it("removes filename path separators and falls back for empty titles", () => {
    expect(markdownDownloadFilename("draft:/today?")).toBe("draft__today_.md");
    expect(markdownDownloadFilename("... ")).toBe("ygdria-notes.md");
  });
});

describe("Markdown archive filename", () => {
  it("names the zip after the single exported top-level note", () => {
    expect(
      markdownArchiveFilename([
        { parentSourceId: null, title: "我的笔记本" },
        { parentSourceId: "root", title: "子笔记" },
      ]),
    ).toBe("我的笔记本.zip");
  });

  it("sanitizes path separators in the top-level note title", () => {
    expect(markdownArchiveFilename([{ parentSourceId: null, title: "a/b:c?" }])).toBe("a_b_c_.zip");
  });

  it("keeps the generic name when several roots are exported", () => {
    expect(
      markdownArchiveFilename([
        { parentSourceId: null, title: "第一篇" },
        { parentSourceId: null, title: "第二篇" },
      ]),
    ).toBe("ygdria-notes.zip");
  });

  it("keeps the generic name when the root was skipped (locked protected note)", () => {
    expect(
      markdownArchiveFilename([
        { parentSourceId: "locked-root", title: "子笔记" },
      ]),
    ).toBe("ygdria-notes.zip");
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
