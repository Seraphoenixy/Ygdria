import { describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { NoteService } from "./index.js";

describe("placement deletion retention", () => {
  it("removes snapshots beyond the count limit and retention period", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const insert = db.sqlite.prepare(
      "INSERT INTO placement_deletions (id,snapshot_json,created_at,undone_at) VALUES (?,?,?,NULL)",
    );
    const timestamp = Date.now();
    insert.run("old", "{}", timestamp - 10_000);
    insert.run("middle", "{}", timestamp - 2);
    insert.run("new", "{}", timestamp - 1);

    expect(service.prunePlacementDeletions(2, Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(db.sqlite.prepare("SELECT id FROM placement_deletions ORDER BY created_at").all()).toEqual([
      { id: "middle" },
      { id: "new" },
    ]);

    expect(service.prunePlacementDeletions(10, 0)).toBe(2);
    expect(db.sqlite.prepare("SELECT COUNT(*) count FROM placement_deletions").get()).toEqual({ count: 0 });
  });
});
