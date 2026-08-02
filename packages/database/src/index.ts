import Database from "better-sqlite3";
export * from "./schema.js";
export * from "./content-codec.js";
export * from "./migrations.js";
export * from "./sync-change-log.js";
/** The better-sqlite3 Database instance type, re-exported so consumers don't need a direct better-sqlite3 dependency. */
export type SqliteDatabase = Database.Database;
export type DatabaseStore = { sqlite: Database.Database };
export function createDatabase(filename = "ygdria.db"): DatabaseStore {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite };
}
