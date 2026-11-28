import type { FastifyInstance } from "fastify";
import type { AttachmentService, NoteService } from "@ygdria/domain";
import { readRetentionPolicy, runSyncDataMaintenance, type SqliteDatabase } from "@ygdria/database";

/** Daily compaction is separate from the minute-scale logical retention pass. */
export function registerRetentionScheduler(
  app: FastifyInstance,
  sqlite: SqliteDatabase,
  notes: NoteService,
  attachments: AttachmentService,
  intervalMs = 60_000,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let closing = false;
  let lastOrphanScan = 0;
  const run = () => {
    if (closing || pending) return pending;
    pending = (async () => {
      const policy = readRetentionPolicy(sqlite);
      const now = Date.now();
      if (policy.trashRetentionMs > 0) notes.purgeTrash(now - policy.trashRetentionMs);
      if (policy.attachmentRetentionMs > 0)
        attachments.clearUnusedAttachments(now - policy.attachmentRetentionMs);
      notes.clearExcessRevisions(policy.revisionLimit);
      await attachments.runStorageCleanup();
      if (now - lastOrphanScan >= 86_400_000) {
        await attachments.cleanOrphanFiles(86_400_000);
        lastOrphanScan = now;
      }
      runSyncDataMaintenance(sqlite);
      // Free pages remain reusable; physical compaction is an explicit task.
      sqlite.pragma("wal_checkpoint(PASSIVE)");
    })()
      .catch((err: unknown) => {
        app.log.error({ err }, "Retention maintenance failed");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  app.addHook("onReady", async () => {
    await run();
    timer = setInterval(() => {
      void run();
    }, intervalMs);
    timer.unref();
  });
  // preClose finishes before app.ts closes the database in onClose.
  app.addHook("preClose", async () => {
    closing = true;
    if (timer) clearInterval(timer);
    await pending;
  });
}
