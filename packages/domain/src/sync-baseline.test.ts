import { describe, expect, it } from "vitest";
import { applyMigrations, advanceCursor, createDatabase } from "@ygdria/database";
import { NoteService } from "./content-service.js";
import { SYSTEM_ROOT_PLACEMENT_ID } from "@ygdria/shared";

describe("authoritative snapshot absence", () => {
  it("removes synchronized missing notes, preserves unsent creations and recovers offline edits", () => {
    const { sqlite } = createDatabase(":memory:");
    applyMigrations(sqlite);
    const notes = new NoteService({ sqlite });
    try {
      const clean = notes.create({ title: "clean" });
      const dirty = notes.create({ title: "offline edit", type: "code", code: "original" });
      const seq = (sqlite.prepare("SELECT MAX(id) id FROM sync_change_log").get() as { id: number })
        .id;
      advanceCursor(sqlite, "out:https://peer", seq);
      notes.update(dirty.id, { code: "offline content", expectedVersion: dirty.version });
      const unsent = notes.create({ title: "unsent" });
      const result = notes.reconcileRemoteNotes("https://peer", [], "recovered");
      expect(result.removed).toBe(2);
      expect(result.recovered).toHaveLength(1);
      expect(notes.get(clean.id)).toBeNull();
      expect(notes.get(dirty.id)).toBeNull();
      expect(notes.get(unsent.id)?.title).toBe("unsent");
      expect(notes.get(result.recovered[0])?.content).toBe("offline content");
      expect(notes.reconcileRemoteNotes("https://peer", [], "recovered")).toEqual({
        removed: 0,
        recovered: [],
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps unsent children reachable when their synchronized parent is absent", () => {
    const { sqlite } = createDatabase(":memory:");
    applyMigrations(sqlite);
    const notes = new NoteService({ sqlite });
    try {
      const parent = notes.create({ title: "parent" });
      const seq = (sqlite.prepare("SELECT MAX(id) id FROM sync_change_log").get() as { id: number })
        .id;
      advanceCursor(sqlite, "out:https://peer", seq);
      const placement = sqlite
        .prepare("SELECT id FROM placements WHERE note_id=?")
        .get(parent.id) as { id: string };
      const child = notes.create({ title: "unsent child", parentPlacementId: placement.id });
      notes.reconcileRemoteNotes("https://peer", [], "recovered");
      expect(notes.get(child.id)?.title).toBe("unsent child");
      expect(
        sqlite
          .prepare("SELECT parent_placement_id parent FROM placements WHERE note_id=?")
          .get(child.id),
      ).toEqual({ parent: SYSTEM_ROOT_PLACEMENT_ID });
    } finally {
      sqlite.close();
    }
  });
  it("changes unacknowledged identities once per compaction generation and retains their content", () => {
    const { sqlite } = createDatabase(":memory:");
    applyMigrations(sqlite);
    const notes = new NoteService({ sqlite });
    try {
      const uncertain = notes.create({
        title: "upload acknowledgement lost",
        type: "code",
        code: "preserved body",
      });
      const first = notes.reconcileRemoteNotes("https://peer", [], "recovered", 1);
      expect(first.recovered).toHaveLength(1);
      expect(notes.get(uncertain.id)).toBeNull();
      expect(notes.get(first.recovered[0])?.content).toBe("preserved body");
      expect(notes.reconcileRemoteNotes("https://peer", [], "recovered", 1)).toEqual({
        removed: 0,
        recovered: [],
      });
      const second = notes.reconcileRemoteNotes("https://peer", [], "recovered", 2);
      expect(second.recovered).toHaveLength(1);
      expect(second.recovered[0]).not.toBe(first.recovered[0]);
      expect(notes.get(second.recovered[0])?.title).toBe("upload acknowledgement lost recovered");
      expect(notes.get(second.recovered[0])?.content).toBe("preserved body");
      const head = (
        sqlite.prepare("SELECT MAX(id) id FROM sync_change_log").get() as { id: number }
      ).id;
      advanceCursor(sqlite, "out:https://peer", head);
      expect(notes.reconcileRemoteNotes("https://peer", [], "recovered", 2)).toEqual({
        removed: 1,
        recovered: [],
      });
    } finally {
      sqlite.close();
    }
  });
});
