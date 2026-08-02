import { applyMigrations, createDatabase } from "./index.js";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "./backup.js";
import { fixDatabase, inspectDatabase } from "./doctor.js";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "doctor": {
      const { sqlite } = createDatabase();
      try {
        applyMigrations(sqlite);
        const fixes = args.includes("--fix") ? fixDatabase(sqlite) : undefined;
        const report = await inspectDatabase(sqlite);
        console.log(JSON.stringify({ report, fixes }, null, 2));
        if (
          report.sqliteIntegrity.some((row: string) => row !== "ok") ||
          report.foreignKeyViolations.length ||
          report.issues.length
        ) {
          process.exitCode = 1;
        }
      } finally {
        sqlite.close();
      }
      break;
    }

    case "backup": {
      const backupDir = args[0] || resolve(homedir(), "ygdria-backups");
      const { sqlite } = createDatabase();
      try {
        applyMigrations(sqlite);
        const schemaVersion = (
          sqlite
            .prepare("SELECT value FROM settings WHERE key='content_schema_version'")
            .get() as { value?: string } | undefined
        )?.value ?? "0";
        const dbPath = process.env.YGDRIA_DATABASE_URL || resolve(homedir(), ".local", "share", "ygdria", "ygdria.db");
        const attachmentRoot = resolve(dirname(dbPath), "attachments");
        const result = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, schemaVersion);
        console.log(JSON.stringify(result, null, 2));
        console.error(`Backup created: ${result.path}`);
      } finally {
        sqlite.close();
      }
      break;
    }

    case "backup:list": {
      const backupDir = args[0] || resolve(homedir(), "ygdria-backups");
      const backups = await listBackups(backupDir);
      if (backups.length === 0) {
        console.log("No backups found in", backupDir);
      } else {
        console.log(JSON.stringify(backups, null, 2));
      }
      break;
    }

    case "backup:verify": {
      const targetDir = args[0];
      if (!targetDir) {
        console.error("Usage: ygdria backup:verify <backup-directory>");
        process.exitCode = 1;
        return;
      }
      if (!existsSync(targetDir)) {
        console.error(`Backup directory not found: ${targetDir}`);
        process.exitCode = 1;
        return;
      }
      const result = await verifyBackup(targetDir);
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = 1;
      break;
    }

    case "restore": {
      const sourceDir = args[0];
      const restoreRoot = args[1] || resolve(homedir(), ".local", "share", "ygdria");
      if (!sourceDir) {
        console.error("Usage: ygdria restore <backup-directory> [restore-root]");
        process.exitCode = 1;
        return;
      }
      if (!existsSync(sourceDir)) {
        console.error(`Backup directory not found: ${sourceDir}`);
        process.exitCode = 1;
        return;
      }
      await mkdir(restoreRoot, { recursive: true });
      const result = await restoreBackup(sourceDir, restoreRoot);
      console.log(JSON.stringify(result, null, 2));
      console.error(`Restore complete. Switch your data directory to:\n  ${result.path}`);
      console.error("Then restart the Ygdria server pointing to the new database.");
      break;
    }

    default:
      console.error(`
Usage: ygdria <command> [options]

Commands:
  doctor [--fix]             Inspect and optionally fix database integrity
  backup [backup-dir]        Create a full backup (database + attachments)
  backup:list [backup-dir]   List available backups
  backup:verify <dir>        Verify a backup's integrity
  restore <backup-dir> [restore-root]  Restore a backup to a new directory
`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});