import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, copyFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AttachmentStorageAdapter } from "@ygdria/domain";
import { mediaType } from "./content-type.js";

export function createAttachmentStorage(
  inMemoryDatabase: boolean,
  databaseUrl: string | undefined,
): { adapter: AttachmentStorageAdapter; root: string } {
  const attachmentRoot = inMemoryDatabase
    ? join(tmpdir(), `ygdria-memory-attachments-${randomUUID()}`)
    : resolve(dirname(databaseUrl ?? "ygdria.db"), "attachments");

  const adapter: AttachmentStorageAdapter = {
    async inspectTemporaryFile(tempFilePath) {
      const data = await readFile(tempFilePath);
      return {
        size: data.length,
        contentHash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        mimeType: await mediaType(tempFilePath),
      };
    },
    async moveToStorage(tempFilePath, storageKey) {
      const target = resolve(attachmentRoot, storageKey.replace(/^attachments\//, ""));
      await mkdir(dirname(target), { recursive: true });
      try {
        await rename(tempFilePath, target);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        try {
          await copyFile(tempFilePath, target);
          await unlink(tempFilePath);
        } catch (copyError) {
          try {
            await rm(target, { force: true });
          } catch {
            /* best-effort cleanup */
          }
          throw copyError;
        }
      }
    },
    async deleteTemporaryFile(tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch {
        /* file may already be cleaned up */
      }
    },
    async deleteStorageFile(storageKey) {
      const target = resolve(attachmentRoot, storageKey.replace(/^attachments\//, ""));
      try {
        await rm(target, { force: true });
      } catch {
        /* already gone */
      }
    },
    async listStorageKeys() {
      const walk = async (directory: string, prefix = ""): Promise<string[]> => {
        const entries: string[] = [];
        const dir = await readdir(directory, { withFileTypes: true });
        for (const entry of dir) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          const target = join(directory, entry.name);
          if (entry.isDirectory()) entries.push(...(await walk(target, relative)));
          else entries.push(`attachments/${relative}`);
        }
        return entries;
      };
      try {
        await mkdir(attachmentRoot, { recursive: true });
      } catch {
        /* root exists */
      }
      try {
        return await walk(attachmentRoot);
      } catch {
        return [];
      }
    },
  };

  return { adapter, root: attachmentRoot };
}