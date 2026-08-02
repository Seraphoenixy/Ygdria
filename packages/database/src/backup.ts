/**
 * Backup and restore for Ygdria data (SQLite database + attachments).
 *
 * Backups are CLI-only (no HTTP download endpoint). The flow:
 *  1. Create a backup bundle directory containing:
 *     - Database copy (via SQLite online backup API)
 *     - Attachment files (copied by hash)
 *     - Manifest (JSON metadata: file hashes, counts, DB version, timestamp)
 *  2. Verify a backup before restoring (manifest check, integrity_check,
 *     attachment hash verification).
 *  3. Restore to a NEW directory; never overwrite in-place. The user must
 *     explicitly switch the active data directory after verification.
 *
 * Retention: configuration-supported but auto-deletion is disabled by default.
 *
 * All filesystem I/O uses node:fs/promises so large backups do not block the
 * event loop. Existence checks use fs/promises' stat-based helpers to stay
 * fully asynchronous.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupManifest = {
  /** Schema version of the backup format. */
  backupVersion: 1;
  /** ISO-8601 timestamp of when the backup was created. */
  createdAt: string;
  /** Database file info. */
  database: {
    /** Filename of the database copy (e.g., "ygdria.db"). */
    filename: string;
    /** SQLite page count at backup time. */
    pageCount: number;
    /** SHA-256 hex digest of the database file. */
    sha256: string;
    /** File size in bytes. */
    sizeBytes: number;
  };
  /** Attachment file info. */
  attachments: {
    /** Number of attachment files backed up. */
    count: number;
    /** Total size of all attachment files in bytes. */
    totalSizeBytes: number;
    /** List of attachment storage keys and their hashes. */
    files: Array<{
      storageKey: string;
      sha256: string;
      sizeBytes: number;
    }>;
  };
  /** Ygdria database version (from content_schema_version setting). */
  schemaVersion: string;
};

export type BackupResult = {
  /** Absolute path to the backup directory. */
  path: string;
  /** The manifest describing this backup. */
  manifest: BackupManifest;
};

export type BackupVerifyResult = {
  /** Whether the backup is valid and usable. */
  valid: boolean;
  /** If invalid, a list of reasons. */
  errors: string[];
  /** The parsed manifest (may be partial on failure). */
  manifest: BackupManifest | null;
  /** Database integrity check output. */
  integrityCheck: string[];
};

export type RestoreResult = {
  /** Absolute path to the restored data directory. */
  path: string;
  /** Number of attachment files restored. */
  attachmentCount: number;
  /** Database file size in bytes. */
  databaseSizeBytes: number;
};

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Create a full backup of the currently open database.
 *
 * @param sqlite       Open better-sqlite3 Database handle (the source).
 * @param dbPath       Filesystem path of the database file (for file stats).
 * @param attachmentRoot  Absolute path to the attachments directory.
 * @param outputDir       Destination directory for the backup bundle.
 * @param schemaVersion  Ygdria schema version (from content_schema_version).
 * @returns A BackupResult with the manifest.
 */
export async function createBackup(
  sqlite: Database.Database,
  dbPath: string,
  attachmentRoot: string,
  outputDir: string,
  schemaVersion: string,
): Promise<BackupResult> {
  const backupId = `ygdria-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = resolve(outputDir, backupId);
  await mkdir(backupDir, { recursive: true });

  const dbFilename = basename(dbPath);
  const dbBackupPath = join(backupDir, dbFilename);
  const attachmentsBackupDir = join(backupDir, "attachments");

  // Step 1: Online backup of the SQLite database.
  // better-sqlite3's backup() is async and returns Promise<BackupMetadata>.
  // It creates a consistent copy via the SQLite online backup API.
  await sqlite.backup(dbBackupPath);

  // Step 2: Gather database file stats.
  const dbStat = await stat(dbBackupPath);
  const dbHash = await hashFile(dbBackupPath);

  // Step 3: Copy attachment files.
  const attachmentFiles: BackupManifest["attachments"]["files"] = [];
  let totalAttachmentBytes = 0;

  if (await pathExists(attachmentRoot)) {
    await mkdir(attachmentsBackupDir, { recursive: true });
    await copyAttachments(attachmentRoot, attachmentsBackupDir, attachmentFiles);
    totalAttachmentBytes = attachmentFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  }

  // Step 4: Build and write the manifest.
  const manifest: BackupManifest = {
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    database: {
      filename: dbFilename,
      pageCount: Number(sqlite.pragma("page_count", { simple: true })),
      sha256: dbHash,
      sizeBytes: dbStat.size,
    },
    attachments: {
      count: attachmentFiles.length,
      totalSizeBytes: totalAttachmentBytes,
      files: attachmentFiles,
    },
    schemaVersion,
  };

  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return { path: backupDir, manifest };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a backup bundle's integrity. Checks:
 *  1. Manifest exists and is parseable.
 *  2. Database file exists and its SHA-256 matches the manifest.
 *  3. PRAGMA integrity_check passes on the database copy.
 *  4. Each attachment file exists and its SHA-256 matches the manifest.
 *
 * Does NOT open the database file for modification — only reads it.
 *
 * @param backupDir Absolute path to the backup directory.
 * @returns Verification result.
 */
export async function verifyBackup(backupDir: string): Promise<BackupVerifyResult> {
  const errors: string[] = [];
  let manifest: BackupManifest | null = null;
  let integrityCheck: string[] = [];

  // 1. Manifest check.
  const manifestPath = join(backupDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    return { valid: false, errors: ["manifest.json not found"], manifest: null, integrityCheck: [] };
  }

  try {
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw) as BackupManifest;
  } catch (err) {
    return { valid: false, errors: [`manifest.json parse error: ${err}`], manifest: null, integrityCheck: [] };
  }

  if (manifest.backupVersion !== 1) {
    errors.push(`Unsupported backup version: ${manifest.backupVersion}`);
  }

  // 2. Database file check.
  const dbPath = join(backupDir, manifest.database.filename);
  if (!(await pathExists(dbPath))) {
    errors.push(`Database file "${manifest.database.filename}" not found in backup`);
  } else {
    const actualHash = await hashFile(dbPath);
    if (actualHash !== manifest.database.sha256) {
      errors.push(`Database file SHA-256 mismatch: expected ${manifest.database.sha256}, got ${actualHash}`);
    }

    // 3. PRAGMA integrity_check. Open the backup copy in read-only mode.
    // We need a separate connection for this. Use a temporary import.
    try {
      const { default: Database } = await import("better-sqlite3");
      const checkDb = new Database(dbPath, { readonly: true });
      try {
        const rows = checkDb.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
        integrityCheck = rows.map((r) => r.integrity_check);
        if (integrityCheck.some((r) => r !== "ok")) {
          errors.push(`Database integrity_check failed: ${integrityCheck.filter((r) => r !== "ok").join("; ")}`);
        }
      } finally {
        checkDb.close();
      }
    } catch (err) {
      errors.push(`Failed to open database for integrity check: ${err}`);
    }
  }

  // 4. Attachment file checks.
  for (const file of manifest.attachments.files) {
    const filePath = join(backupDir, file.storageKey);
    if (!(await pathExists(filePath))) {
      errors.push(`Attachment file missing: ${file.storageKey}`);
      continue;
    }
    const actualHash = await hashFile(filePath);
    if (actualHash !== file.sha256) {
      errors.push(`Attachment SHA-256 mismatch for ${file.storageKey}: expected ${file.sha256}, got ${actualHash}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest,
    integrityCheck,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a backup to a new directory (never overwrite in-place).
 *
 * 1. Verifies the backup integrity first.
 * 2. Creates a new data directory with a timestamp suffix.
 * 3. Copies the database and attachment files into it.
 * 4. Does NOT switch the active data directory — the caller must do that
 *    explicitly after confirming the restored data is correct.
 *
 * @param backupDir   Absolute path to the backup directory.
 * @param restoreRoot Absolute path to the parent directory where the restored
 *                    data will be placed (e.g., ~/.local/share/ygdria/).
 * @returns RestoreResult with the new directory path.
 * @throws If verification fails.
 */
export async function restoreBackup(
  backupDir: string,
  restoreRoot: string,
): Promise<RestoreResult> {
  // Step 1: Verify the backup before touching anything.
  const verification = await verifyBackup(backupDir);
  if (!verification.valid) {
    throw new Error(
      `Backup verification failed:\n  ${verification.errors.join("\n  ")}`,
    );
  }

  const manifest = verification.manifest!;
  const restoreDir = resolve(
    restoreRoot,
    `ygdria-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

  // Step 2: Create the restore directory.
  await mkdir(restoreDir, { recursive: true });

  try {
    // Step 3: Copy the database file.
    const srcDb = join(backupDir, manifest.database.filename);
    const dstDb = join(restoreDir, manifest.database.filename);
    await copyFile(srcDb, dstDb);

    // Step 4: Copy attachment files.
    const srcAttachments = join(backupDir, "attachments");
    let attachmentCount = 0;
    if (await pathExists(srcAttachments)) {
      for (const file of manifest.attachments.files) {
        const src = join(backupDir, file.storageKey);
        const dst = join(restoreDir, file.storageKey);
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(src, dst);
        attachmentCount++;
      }
    }

    const dbStat = await stat(dstDb);

    return {
      path: restoreDir,
      attachmentCount,
      databaseSizeBytes: dbStat.size,
    };
  } catch (err) {
    // Clean up the partial restore directory on failure.
    try { await rm(restoreDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// List backups
// ---------------------------------------------------------------------------

/**
 * List all backup directories in the given output directory.
 * Returns only directories that contain a valid manifest.json.
 */
export async function listBackups(outputDir: string): Promise<Array<{ path: string; createdAt: string; databaseSizeBytes: number; attachmentCount: number }>> {
  if (!(await pathExists(outputDir))) return [];

  const entries = await readdir(outputDir, { withFileTypes: true });
  const backups: Array<{ path: string; createdAt: string; databaseSizeBytes: number; attachmentCount: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(outputDir, entry.name, "manifest.json");
    if (!(await pathExists(manifestPath))) continue;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
      backups.push({
        path: resolve(outputDir, entry.name),
        createdAt: manifest.createdAt,
        databaseSizeBytes: manifest.database.sizeBytes,
        attachmentCount: manifest.attachments.count,
      });
    } catch {
      // Skip directories with unparseable manifests.
    }
  }

  // Sort newest first.
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return backups;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Asynchronous existence check. Returns false on ENOENT, throws on other errors. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Recursively copy attachment files from source to destination,
 * collecting metadata for the manifest.
 */
async function copyAttachments(
  srcDir: string,
  dstDir: string,
  files: BackupManifest["attachments"]["files"],
  prefix = "attachments",
): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      await mkdir(dstPath, { recursive: true });
      await copyAttachments(srcPath, dstPath, files, `${prefix}/${entry.name}`);
    } else if (entry.isFile()) {
      await copyFile(srcPath, dstPath);
      const st = await stat(srcPath);
      const hash = await hashFile(srcPath);
      files.push({
        storageKey: `${prefix}/${entry.name}`,
        sha256: hash,
        sizeBytes: st.size,
      });
    }
  }
}
