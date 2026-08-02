import { applyMigrations, createDatabase } from "./index.js";
import { inspectSearchIndex, rebuildSearchIndex } from "./search-index.js";
import { fixDatabase, inspectDatabase } from "./doctor.js";

const command = process.argv[2];
const { sqlite } = createDatabase();

try {
  applyMigrations(sqlite);

  if (command === "migrate") {
    console.log("Ygdria migrations applied");
  } else if (command === "rebuild-search-index") {
    const diagnostics = process.argv.includes("--check")
      ? inspectSearchIndex(sqlite)
      : rebuildSearchIndex(sqlite);
    console.log(JSON.stringify(diagnostics, null, 2));
  } else if (command === "doctor") {
    const fix = process.argv.includes("--fix");
    const fixes = fix ? fixDatabase(sqlite) : undefined;
    const report = await inspectDatabase(sqlite);
    console.log(JSON.stringify({ report, fixes }, null, 2));
    if (report.sqliteIntegrity.some((row: string) => row !== "ok") || report.foreignKeyViolations.length || report.issues.length) {
      process.exitCode = 1;
    }
  } else {
    console.error(`Usage: tsx src/cli.ts <command>`);
    console.error(`Commands: migrate, rebuild-search-index [--check], doctor [--fix]`);
    process.exitCode = 1;
  }
} finally {
  sqlite.close();
}