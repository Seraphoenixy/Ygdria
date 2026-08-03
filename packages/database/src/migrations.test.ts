import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations.js";

function createDb() {
  return new Database(":memory:");
}

describe("migration integrity", () => {
  it("records stable checksums and remains idempotent", () => {
    const sqlite = createDb();

    applyMigrations(sqlite);
    applyMigrations(sqlite);

    expect(sqlite.prepare("SELECT value FROM migration_integrity_metadata WHERE key='checksum_format'").get())
      .toEqual({ value: "stable-v1" });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM schema_migrations").get()).toEqual({ count: 4 });
  });

  it("rejects the removed file note type", () => {
    const sqlite = createDb();
    applyMigrations(sqlite);

    expect(() => sqlite.prepare("UPDATE notes SET type='file' WHERE id=?").run("00000000-0000-4000-8000-000000000001"))
      .toThrow(/Invalid note type/);
  });

  it("upgrades an existing v11 database without requiring removed migrations", () => {
    const sqlite = createDb();
    applyMigrations(sqlite);
    sqlite.prepare("DELETE FROM schema_migrations WHERE version IN (12,13,14)").run();
    sqlite.prepare("UPDATE notes SET title=? WHERE id=?").run("v11 data survives", "00000000-0000-4000-8000-000000000001");

    applyMigrations(sqlite);

    expect(sqlite.prepare("SELECT title FROM notes WHERE id=?").get("00000000-0000-4000-8000-000000000001"))
      .toEqual({ title: "v11 data survives" });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM schema_migrations").get()).toEqual({ count: 4 });
    expect(sqlite.prepare("PRAGMA table_info(sync_rebaseline_required)").all())
      .toContainEqual(expect.objectContaining({ name: "snapshot_max_change_id" }));
  });

  it("rejects a changed checksum after the stable-format upgrade", () => {
    const sqlite = createDb();
    applyMigrations(sqlite);
    sqlite.prepare("UPDATE schema_migrations SET checksum=? WHERE version=11").run("abcdefabcdefabcd");

    expect(() => applyMigrations(sqlite)).toThrow(/checksum mismatch/);
  });
});
