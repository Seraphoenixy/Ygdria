import { describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService } from "./index.js";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

describe("NoteService.sizeForPlacement", () => {
  it("measures the note and its subtree without double-counting shared attachments", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const sharedId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const parentContent = {
      type: "doc",
      content: [{ type: "image", attrs: { src: `/api/v1/attachments/${sharedId}` } }],
    };
    const childContent = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: `/api/v1/attachments/${sharedId}` } },
        { type: "image", attrs: { src: `/api/v1/attachments/${childId}` } },
      ],
    };
    const parent = service.create({ title: "Parent", content: parentContent });
    const parentPlacement = service
      .tree()
      .find((placement: any) => placement.noteId === parent.id) as { placementId: string };
    const child = service.create({
      title: "Child",
      content: childContent,
      parentPlacementId: parentPlacement.placementId,
    });

    db.sqlite
      .prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?)")
      .run(
        sharedId,
        "shared.bin",
        "application/octet-stream",
        11,
        "attachments/shared",
        "sha256:shared",
        Date.now(),
      );
    db.sqlite
      .prepare("INSERT INTO attachments VALUES (?,?,?,?,?,?,?)")
      .run(
        childId,
        "child.bin",
        "application/octet-stream",
        7,
        "attachments/child",
        "sha256:child",
        Date.now(),
      );
    const result = service.sizeForPlacement(parentPlacement.placementId);
    const parentContentBytes = bytes("Parent") + bytes(JSON.stringify(parentContent)) + bytes("{}");
    const childContentBytes = bytes("Child") + bytes(JSON.stringify(childContent)) + bytes("{}");

    expect(result.note).toEqual({
      contentBytes: parentContentBytes,
      storedContentBytes: parentContentBytes,
      attachmentBytes: 11,
      totalBytes: parentContentBytes + 11,
      storedTotalBytes: parentContentBytes + 11,
    });
    expect(result.subtree).toEqual({
      noteCount: 2,
      contentBytes: parentContentBytes + childContentBytes,
      storedContentBytes: parentContentBytes + childContentBytes,
      attachmentBytes: 18,
      totalBytes: parentContentBytes + childContentBytes + 18,
      storedTotalBytes: parentContentBytes + childContentBytes + 18,
    });
  });

  it("reports compressed document payloads separately from their logical size", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const note = service.create({ title: "Compressed", type: "code", code: "a".repeat(8_192) });
    const placement = service.tree().find((item: any) => item.noteId === note.id) as {
      placementId: string;
    };

    const result = service.sizeForPlacement(placement.placementId);

    expect(result.note.contentBytes).toBe(
      bytes("Compressed") + 8_192 + bytes('{"codeLanguage":"plaintext"}'),
    );
    expect(result.note.storedContentBytes).toBeLessThan(result.note.contentBytes);
    expect(result.note.storedTotalBytes).toBe(result.note.storedContentBytes);
  });
});
