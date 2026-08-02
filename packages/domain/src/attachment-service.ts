import { randomUUID } from "node:crypto";
import { decodeStoredContent, recordChange, type ContentCodec, type createDatabase } from "@ygdria/database";
import { NotFoundError } from "./note-service-base.js";

type Store = ReturnType<typeof createDatabase>;
const now = () => Date.now();
const id = () => randomUUID();

export interface AttachmentStorageAdapter {
  inspectTemporaryFile(tempFilePath: string):
    | Promise<{ size: number; contentHash: string; mimeType: string }>
    | {
        size: number;
        contentHash: string;
        mimeType: string;
      };
  moveToStorage(tempFilePath: string, storageKey: string): Promise<void> | void;
  deleteTemporaryFile(tempFilePath: string): Promise<void> | void;
  deleteStorageFile(storageKey: string): Promise<void> | void;
  /** Returns keys below Ygdria's attachment storage root only. */
  listStorageKeys(): Promise<string[]> | string[];
}

export interface AddAttachmentInput {
  noteId: string;
  attachmentId?: string;
  filename: string;
  tempFilePath: string;
  maxSizeBytes?: number;
  allowedMimeTypes?: readonly string[];
  /** False when materializing an attachment that was pulled from a sync peer. */
  recordSyncChange?: boolean;
}

export class AttachmentService {
  constructor(
    private store: Store,
    private adapter: AttachmentStorageAdapter,
  ) {}
  attachment(id: string) {
    const attachment = this.store.sqlite
      .prepare(
        "SELECT id,filename,mime_type mimeType,size,storage_key storageKey FROM attachments WHERE id=?",
      )
      .get(id) as
      | { id: string; filename: string; mimeType: string; size: number; storageKey: string }
      | undefined;
    if (!attachment) throw new NotFoundError("Attachment not found");
    return attachment;
  }

  /** Protected documents are opaque to the server, so they cannot participate
   * in content-derived attachment lifetime management. */
  assertUploadAllowed(noteId: string) {
    const note = this.store.sqlite
      .prepare("SELECT is_protected isProtected FROM notes WHERE id=? AND deleted_at IS NULL")
      .get(noteId) as { isProtected: number } | undefined;
    if (!note) throw new NotFoundError("Note not found");
    if (note.isProtected) throw new Error("Protected notes cannot contain attachments");
  }

  /**
   * 遵循协议原子的插入附件：
   * 1. 从临时文件读取并校验大小、MIME、哈希；
   * 2. 重命名/移动到正式 storage key；
   * 3. 在 SQLite 事务中插入附件记录；
   * 4. 若数据库事务失败，删除正式文件。
   */
  async addAttachment(input: AddAttachmentInput) {
    if (!input.filename || !input.tempFilePath) throw new Error("Invalid attachment input");

    const file = await this.adapter.inspectTemporaryFile(input.tempFilePath);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !file.contentHash || !file.mimeType) {
      throw new Error("Invalid attachment file metadata");
    }
    if (input.maxSizeBytes !== undefined && file.size > input.maxSizeBytes) {
      throw new Error(`Attachment size ${file.size} exceeds maximum ${input.maxSizeBytes}`);
    }
    if (input.allowedMimeTypes && !input.allowedMimeTypes.includes(file.mimeType)) {
      throw new Error(`Attachment MIME type ${file.mimeType} is not allowed`);
    }

    this.assertUploadAllowed(input.noteId);

    if (input.attachmentId) {
      const idCollision = this.store.sqlite
        .prepare("SELECT content_hash contentHash,size FROM attachments WHERE id=?")
        .get(input.attachmentId) as { contentHash: string; size: number } | undefined;
      if (idCollision && (idCollision.contentHash !== file.contentHash || idCollision.size !== file.size))
        throw new Error("Attachment id already belongs to different content");
    }

    // Identical content is stored once and linked to every referencing note.
    // The hash is calculated from the upload before the temporary file moves.
    const existing = this.store.sqlite
      .prepare(
        "SELECT id,filename,mime_type mimeType,size,storage_key storageKey,content_hash contentHash,created_at createdAt FROM attachments WHERE content_hash=? AND size=? LIMIT 1",
      )
      .get(file.contentHash, file.size) as
      | {
          id: string;
          filename: string;
          mimeType: string;
          size: number;
          storageKey: string;
          contentHash: string;
          createdAt: number;
        }
      | undefined;
    if (existing && (!input.attachmentId || input.attachmentId === existing.id)) {
      await this.adapter.deleteTemporaryFile(input.tempFilePath);
      return { ...existing, createdAt: new Date(existing.createdAt).toISOString() };
    }

    const attachmentId = input.attachmentId ?? id();
    const storageKey = `attachments/${attachmentId}`;

    // Step 1 & 2: 移动临时文件到正式 storage key
    await this.adapter.moveToStorage(input.tempFilePath, storageKey);

    const t = now();
    try {
      // Step 3: 在 SQLite 事务中插入附件和关联记录
      this.store.sqlite.transaction(() => {
        this.store.sqlite
          .prepare(
            "INSERT INTO attachments (id,filename,mime_type,size,storage_key,content_hash,created_at) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            attachmentId,
            input.filename,
            file.mimeType,
            file.size,
            storageKey,
            file.contentHash,
            t,
          );

        if (input.recordSyncChange !== false) {
          recordChange(this.store.sqlite, "attachment", attachmentId, "created");
        }
      })();
    } catch (err) {
      // Step 4: 若数据库事务失败，删除正式文件
      try {
        await this.adapter.deleteStorageFile(storageKey);
      } catch {
        this.enqueueCleanup(storageKey, "upload-rollback");
      }
      throw err;
    }

    return {
      id: attachmentId,
      filename: input.filename,
      mimeType: file.mimeType,
      size: file.size,
      storageKey,
      contentHash: file.contentHash,
      createdAt: new Date(t).toISOString(),
    };
  }

  /**
   * Returns the number of attachments that are not referenced by any note.
   */
  countUnusedAttachments(): number {
    const referenced = this.referencedAttachmentIds();
    return (this.store.sqlite.prepare("SELECT id FROM attachments").all() as { id: string }[])
      .filter((attachment) => !referenced.has(attachment.id)).length;
  }

  /**
   * Returns every stored attachment together with the notes that actually
   * reference it. Ownership is derived by scanning note content for
   * `/api/v1/attachments/<id>` references (protected and code notes are
   * opaque to the server, so attachments referenced only from them appear
   * as orphaned here).
   */
  listAttachments(): Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    createdAt: string;
    contentHash: string;
    referencingNotes: Array<{ id: string; title: string }>;
  }> {
    const attachments = this.store.sqlite
      .prepare(
        "SELECT id,filename,mime_type mimeType,size,storage_key storageKey,content_hash contentHash,created_at createdAt FROM attachments ORDER BY created_at DESC",
      )
      .all() as Array<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      storageKey: string;
      contentHash: string;
      createdAt: number;
    }>;

    // Reverse map: attachmentId -> referencing note ids, plus a title lookup.
    // Only non-protected, non-code, non-deleted notes are scannable.
    const referencingByAttachment = new Map<string, Set<string>>();
    const noteTitles = new Map<string, string>();
    const noteRows = this.store.sqlite
      .prepare(
        "SELECT id,title,content_data contentData,content_codec contentCodec FROM notes WHERE is_protected=0 AND type<>'code' AND deleted_at IS NULL",
      )
      .all() as Array<{ id: string; title: string; contentData: Buffer; contentCodec: ContentCodec }>;
    for (const row of noteRows) {
      noteTitles.set(row.id, row.title);
      const content = decodeStoredContent(row.contentData, row.contentCodec);
      if (typeof content !== "string") continue;
      for (const match of content.matchAll(/\/api\/v1\/attachments\/([0-9a-f-]{36})(?:["'?/#]|$)/gi)) {
        const attachmentId = match[1];
        const noteIds = referencingByAttachment.get(attachmentId) ?? new Set<string>();
        noteIds.add(row.id);
        referencingByAttachment.set(attachmentId, noteIds);
      }
    }

    return attachments.map((attachment) => {
      const noteIds = referencingByAttachment.get(attachment.id) ?? new Set<string>();
      const referencingNotes = [...noteIds].map((id) => ({ id, title: noteTitles.get(id) ?? id }));
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        createdAt: new Date(attachment.createdAt).toISOString(),
        contentHash: attachment.contentHash,
        referencingNotes,
      };
    });
  }

  /**
   * Deletes all attachments that are not referenced by any note and queues
   * their storage keys for cleanup. Returns the number of removed attachments.
   */
  clearUnusedAttachments(before?: number): { count: number; attachmentStorageKeys: string[] } {
    const referenced = this.referencedAttachmentIds();
    const rows = (this.store.sqlite.prepare("SELECT id,storage_key storageKey,created_at createdAt FROM attachments").all() as { id: string; storageKey: string; createdAt: number }[])
      .filter((attachment) => !referenced.has(attachment.id) && (before === undefined || attachment.createdAt <= before));
    const attachmentStorageKeys: string[] = [];
    this.store.sqlite.transaction(() => {
      for (const attachment of rows) {
        this.store.sqlite.prepare("DELETE FROM attachments WHERE id=?").run(attachment.id);
        this.enqueueCleanup(attachment.storageKey, "unused-attachment");
        recordChange(this.store.sqlite, "attachment", attachment.id, "deleted");
        attachmentStorageKeys.push(attachment.storageKey);
      }
    })();
    return { count: rows.length, attachmentStorageKeys };
  }

  /**
   * Registers scanned orphan files, then attempts all durable cleanup jobs.
   */
  async cleanOrphanFiles(): Promise<{ deletedKeys: string[] }> {
    const physicalKeys = await this.adapter.listStorageKeys();
    const rows = this.store.sqlite
      .prepare("SELECT storage_key storageKey FROM attachments")
      .all() as { storageKey: string }[];
    const dbKeys = new Set(rows.map((r) => r.storageKey));

    for (const key of physicalKeys) {
      if (key.startsWith("attachments/") && !dbKeys.has(key))
        this.enqueueCleanup(key, "orphan-scan");
    }
    return this.runStorageCleanup();
  }

  async runStorageCleanup(): Promise<{ deletedKeys: string[] }> {
    const jobs = this.store.sqlite
      .prepare(
        "SELECT id,storage_key storageKey FROM storage_cleanup_jobs WHERE completed_at IS NULL ORDER BY created_at",
      )
      .all() as { id: string; storageKey: string }[];
    const deletedKeys: string[] = [];
    for (const job of jobs) {
      const exists = this.store.sqlite
        .prepare("SELECT 1 FROM attachments WHERE storage_key=?")
        .get(job.storageKey);
      if (exists) {
        this.store.sqlite
          .prepare("UPDATE storage_cleanup_jobs SET completed_at=?,last_error=NULL WHERE id=?")
          .run(now(), job.id);
        continue;
      }
      try {
        await this.adapter.deleteStorageFile(job.storageKey);
        this.store.sqlite
          .prepare("UPDATE storage_cleanup_jobs SET completed_at=?,last_error=NULL WHERE id=?")
          .run(now(), job.id);
        deletedKeys.push(job.storageKey);
      } catch (error) {
        this.store.sqlite
          .prepare("UPDATE storage_cleanup_jobs SET attempts=attempts+1,last_error=? WHERE id=?")
          .run(error instanceof Error ? error.message : String(error), job.id);
      }
    }
    return { deletedKeys };
  }

  private enqueueCleanup(storageKey: string, reason: string) {
    this.store.sqlite
      .prepare(
        "INSERT OR IGNORE INTO storage_cleanup_jobs (id,storage_key,reason,attempts,created_at) VALUES (?,?,?,?,?)",
      )
      .run(id(), storageKey, reason, 0, now());
  }

  private referencedAttachmentIds() {
    const ids = new Set<string>();
    const rows = this.store.sqlite.prepare("SELECT content_data contentData,content_codec contentCodec FROM notes WHERE is_protected=0 AND type<>'code'").all() as Array<{ contentData: Buffer; contentCodec: ContentCodec }>;
    for (const row of rows) {
      const content = decodeStoredContent(row.contentData, row.contentCodec);
      for (const match of content.matchAll(/\/api\/v1\/attachments\/([0-9a-f-]{36})(?:["'?/#]|$)/gi)) ids.add(match[1]);
    }
    return ids;
  }
}
