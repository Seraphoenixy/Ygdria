import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { AttachmentService, NoteService, type AttachmentStorageAdapter } from "./index.js";

class MemoryStorageAdapter implements AttachmentStorageAdapter {
  public files = new Map<string, string>();

  inspectTemporaryFile(tempFilePath: string) {
    const content = this.files.get(tempFilePath);
    if (content === undefined) throw new Error("Temporary file not found");
    return { size: content.length, contentHash: `sha256:${content}`, mimeType: "text/plain" };
  }

  moveToStorage(tempFilePath: string, storageKey: string) {
    const content = this.files.get(tempFilePath);
    if (content === undefined) throw new Error("Temporary file not found");
    this.files.delete(tempFilePath);
    this.files.set(storageKey, content);
  }

  deleteTemporaryFile(tempFilePath: string) {
    this.files.delete(tempFilePath);
  }

  deleteStorageFile(storageKey: string) {
    this.files.delete(storageKey);
  }

  listStorageKeys() {
    return [...this.files.keys()].filter((key) => key.startsWith("attachments/"));
  }
}

describe("AttachmentService", () => {
  let db: ReturnType<typeof createDatabase>;
  let adapter: MemoryStorageAdapter;
  let service: AttachmentService;
  let notes: NoteService;
  let firstNoteId: string;
  let secondNoteId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    adapter = new MemoryStorageAdapter();
    service = new AttachmentService(db, adapter);
    notes = new NoteService(db);
    firstNoteId = notes.create({ title: "First" }).id;
    secondNoteId = notes.create({ title: "Second" }).id;
  });

  it("stores attachment metadata without creating a note join row", async () => {
    adapter.files.set("tmp/upload", "hello");
    const attachment = await service.addAttachment({
      noteId: firstNoteId,
      filename: "Example.TXT",
      tempFilePath: "tmp/upload",
      maxSizeBytes: 10,
    });

    expect(attachment.storageKey).toMatch(/^attachments\/[a-f0-9-]+$/);
    expect(attachment.size).toBe(5);
    expect(attachment.contentHash).toBe("sha256:hello");
    expect(adapter.files.has(attachment.storageKey)).toBe(true);
    expect(db.sqlite.prepare("SELECT 1 FROM attachments WHERE id=?").get(attachment.id)).toBeDefined();
  });

  it("deduplicates identical uploads by content hash", async () => {
    adapter.files.set("tmp/first", "same file");
    const first = await service.addAttachment({ noteId: firstNoteId, filename: "first.txt", tempFilePath: "tmp/first" });
    adapter.files.set("tmp/second", "same file");
    const second = await service.addAttachment({ noteId: secondNoteId, filename: "second.txt", tempFilePath: "tmp/second" });

    expect(second.id).toBe(first.id);
    expect(adapter.files.has("tmp/second")).toBe(false);
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM attachments").get()).toEqual({ count: 1 });
  });

  it("counts and clears attachments not referenced by any note", async () => {
    adapter.files.set("tmp/used", "used");
    adapter.files.set("tmp/unused", "unused");
    const used = await service.addAttachment({ noteId: firstNoteId, filename: "used.txt", tempFilePath: "tmp/used" });
    const unused = await service.addAttachment({ noteId: secondNoteId, filename: "unused.txt", tempFilePath: "tmp/unused" });
    notes.update(firstNoteId, { content: { type: "doc", content: [{ type: "image", attrs: { src: `/api/v1/attachments/${used.id}` } }] }, expectedVersion: 1 });

    expect(service.countUnusedAttachments()).toBe(1);
    const result = service.clearUnusedAttachments();
    expect(result.count).toBe(1);
    expect(result.attachmentStorageKeys).toContain(unused.storageKey);

    expect(db.sqlite.prepare("SELECT 1 FROM attachments WHERE id=?").get(unused.id)).toBeUndefined();
    expect(service.countUnusedAttachments()).toBe(0);
    expect(adapter.files.has(unused.storageKey)).toBe(true);

    // The deletion must be recorded in the sync change log so peer devices
    // converge; otherwise other devices would keep a stale attachment row.
    const logged = db.sqlite
      .prepare("SELECT 1 FROM sync_change_log WHERE entity_type='attachment' AND entity_id=? AND change_kind='deleted'")
      .get(unused.id);
    expect(logged).toBeDefined();

    await service.runStorageCleanup();
    expect(adapter.files.has(unused.storageKey)).toBe(false);
    expect(adapter.files.has(used.storageKey)).toBe(true);
  });
});
