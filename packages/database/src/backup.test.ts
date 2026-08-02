/**
 * Backup and restore integration tests.
 *
 * Tests the full backup → verify → restore cycle using temporary directories
 * and file-based SQLite databases (backup() does not work on :memory: databases).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, applyMigrations } from "./index.js";
import { createBackup, verifyBackup, restoreBackup, listBackups } from "./backup.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

let testDir: string;
let dbPath: string;
let attachmentRoot: string;
let backupDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ygdria-backup-test-${randomUUID()}`);
  dbPath = join(testDir, "ygdria.db");
  attachmentRoot = join(testDir, "attachments");
  backupDir = join(testDir, "backups");
  await mkdir(testDir, { recursive: true });
  await mkdir(attachmentRoot, { recursive: true });
  await mkdir(backupDir, { recursive: true });
});

afterEach(async () => {
  try { await rm(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("backup and restore", () => {
  it("creates a backup with manifest, database copy, and attachments", async () => {
    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);
    // Create a test attachment file.
    await writeFile(join(attachmentRoot, "test-file.txt"), "hello world");

    const result = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");

    expect(result.path).toBeDefined();
    expect(result.manifest.backupVersion).toBe(1);
    expect(result.manifest.database.filename).toBe("ygdria.db");
    expect(result.manifest.database.sha256).toHaveLength(64);
    expect(result.manifest.database.sizeBytes).toBeGreaterThan(0);
    expect(result.manifest.attachments.count).toBe(1);
    expect(result.manifest.attachments.files[0].storageKey).toBe("attachments/test-file.txt");
    expect(result.manifest.attachments.files[0].sha256).toHaveLength(64);
    expect(result.manifest.schemaVersion).toBe("1");
    expect(existsSync(join(result.path, "manifest.json"))).toBe(true);
    expect(existsSync(join(result.path, "ygdria.db"))).toBe(true);
    expect(existsSync(join(result.path, "attachments", "test-file.txt"))).toBe(true);

    sqlite.close();
  });

  it("verifies a valid backup", async () => {
    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);
    await writeFile(join(attachmentRoot, "data.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));

    const result = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");
    const verification = await verifyBackup(result.path);

    expect(verification.valid).toBe(true);
    expect(verification.errors).toHaveLength(0);
    expect(verification.manifest).not.toBeNull();
    expect(verification.integrityCheck).toContain("ok");

    sqlite.close();
  });

  it("detects a corrupted database in verification", async () => {
    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);
    const result = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");
    sqlite.close();

    // Corrupt the database file in the backup.
    await writeFile(join(result.path, "ygdria.db"), Buffer.from("corrupted data"));

    const verification = await verifyBackup(result.path);
    expect(verification.valid).toBe(false);
    expect(verification.errors.length).toBeGreaterThan(0);
    // Should detect the hash mismatch.
    expect(verification.errors.some((e) => e.includes("SHA-256 mismatch"))).toBe(true);
  });

  it("restores a backup to a new directory", async () => {
    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);
    await writeFile(join(attachmentRoot, "restore-me.txt"), "restore content");

    const backupResult = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");
    sqlite.close();

    const restoreRoot = join(testDir, "restore");
    const restoreResult = await restoreBackup(backupResult.path, restoreRoot);

    expect(restoreResult.path).toBeDefined();
    expect(restoreResult.path).not.toBe(dbPath); // Must be a new directory.
    expect(restoreResult.attachmentCount).toBe(1);
    expect(restoreResult.databaseSizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(restoreResult.path, "ygdria.db"))).toBe(true);
    expect(existsSync(join(restoreResult.path, "attachments", "restore-me.txt"))).toBe(true);

    // The restored database should be openable and pass integrity check.
    const { sqlite: restoredDb } = createDatabase(join(restoreResult.path, "ygdria.db"));
    const integrity = restoredDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe("ok");
    restoredDb.close();
  });

  it("refuses to restore a corrupted backup", async () => {
    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);
    const result = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");
    sqlite.close();

    // Corrupt the database.
    await writeFile(join(result.path, "ygdria.db"), Buffer.from("corrupted"));

    await expect(restoreBackup(result.path, join(testDir, "restore"))).rejects.toThrow();
  });

  it("lists backups sorted by creation time", async () => {
    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);

    const r1 = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");
    // Small delay to ensure different timestamps.
    await new Promise((r) => setTimeout(r, 1100));
    const r2 = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");

    const backups = await listBackups(backupDir);
    expect(backups).toHaveLength(2);
    // Newest first.
    expect(backups[0].path).toBe(r2.path);
    expect(backups[1].path).toBe(r1.path);

    sqlite.close();
  });

  it("handles backup with no attachments directory", async () => {
    // Remove the attachments directory.
    await rm(attachmentRoot, { recursive: true, force: true });

    const { sqlite } = createDatabase(dbPath);
    applyMigrations(sqlite);

    const result = await createBackup(sqlite, dbPath, attachmentRoot, backupDir, "1");
    expect(result.manifest.attachments.count).toBe(0);
    expect(result.manifest.attachments.files).toHaveLength(0);

    const verification = await verifyBackup(result.path);
    expect(verification.valid).toBe(true);

    sqlite.close();
  });
});
