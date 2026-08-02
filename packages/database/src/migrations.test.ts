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
    expect(sqlite.prepare("SELECT COUNT(*) count FROM schema_migrations").get()).toEqual({ count: 10 });
  });

  it("upgrades the legacy Electron runtime checksum once", () => {
    const sqlite = createDb();
    applyMigrations(sqlite);
    sqlite.prepare("DELETE FROM migration_integrity_metadata WHERE key='checksum_format'").run();
    sqlite.prepare("DELETE FROM schema_migrations WHERE version=7").run();
    // This is the checksum reported by affected packaged desktop builds.
    sqlite.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("7d99750f3aec320d");

    applyMigrations(sqlite);

    expect(sqlite.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get())
      .not.toEqual({ checksum: "7d99750f3aec320d" });
    expect(sqlite.prepare("SELECT value FROM migration_integrity_metadata WHERE key='checksum_format'").get())
      .toEqual({ value: "stable-v1" });
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_change_log'").get())
      .toEqual({ name: "sync_change_log" });
  });

  it("rejects a changed checksum after the stable-format upgrade", () => {
    const sqlite = createDb();
    applyMigrations(sqlite);
    sqlite.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("abcdefabcdefabcd");

    expect(() => applyMigrations(sqlite)).toThrow(/checksum mismatch/);
  });
});
