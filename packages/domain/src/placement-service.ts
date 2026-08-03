import {
  decodeStoredContent,
  recordChange,
  recordChanges,
  type ChangeKind,
  type ContentCodec,
} from "@ygdria/database";
import {
  CALENDAR_PLACEMENT_ID,
  CALENDAR_NOTE_ID,
  PLACEMENT_DELETION_MAX_RECORDS,
  PLACEMENT_DELETION_RETENTION_MS,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_ROOT_PLACEMENT_ID,
  SYSTEM_TRASH_NOTE_ID,
  SYSTEM_TRASH_PLACEMENT_ID,
} from "@ygdria/shared";
import {
  ConflictError,
  id,
  NotFoundError,
  type PlacementSnapshot,
  type IdRow,
  type PositionRow,
  type TreeRow,
  now,
  NoteServiceBase,
} from "./note-service-base.js";

export class PlacementService extends NoteServiceBase {
  remove(noteId: string) {
    this.assertNotSystemNote(noteId);
    if (!this.get(noteId)) throw new NotFoundError();
    const undoId = id();
    this.store.sqlite.transaction(() => {
      // A note can have several placements (clones). Deleting the entity removes
      // every such placement and their placement subtrees, so retain the complete
      // structural snapshot before SQLite cascades those rows.
      const placements = this.placementSubtreesForNote(noteId);
      // Capture the note's own placement ids before they are deleted so the
      // deletion can be mirrored on sync peers. Without this, a peer that only
      // receives `note deleted` keeps the trashed note's former tree positions,
      // leaving its database inconsistent with this one.
      const originalPlacementIds = (
        this.store.sqlite.prepare("SELECT id FROM placements WHERE note_id=?").all(noteId) as IdRow[]
      ).map((row) => row.id as string);
      const affected = this.placementSubtreeNoteIdsForNote(noteId);
      this.store.sqlite.prepare("DELETE FROM placements WHERE note_id=?").run(noteId);
      const autoTrashedNoteIds = this.moveOrphanNotesToTrash(affected, noteId);
      const snapshot: PlacementSnapshot = { placements, autoTrashedNoteIds };
      this.recordPlacementDeletion(undoId, snapshot);
      recordChange(this.store.sqlite, "note", noteId, "deleted", now());
      if (originalPlacementIds.length > 0) {
        recordChanges(
          this.store.sqlite,
          originalPlacementIds.map((placementId) => ({
            entityType: "placement",
            entityId: placementId,
            changeKind: "deleted" as const,
          })),
        );
      }
    })();
    return { undoId };
  }
  /** Restores the latest still-available deletion action that trashed this note. */
  restore(noteId: string) {
    const records = this.store.sqlite
      .prepare(
        "SELECT id,snapshot_json FROM placement_deletions WHERE undone_at IS NULL ORDER BY created_at DESC",
      )
      .all() as Array<{ id: string; snapshot_json: string }>;
    for (const record of records) {
      try {
        const snapshot = JSON.parse(record.snapshot_json) as PlacementSnapshot;
        if (snapshot.autoTrashedNoteIds?.includes(noteId)) {
          this.undoPlacementDeletion(record.id);
          return { undoId: record.id };
        }
      } catch {
        // Ignore a legacy/corrupt undo record; normal doctor checks can report it.
      }
    }
    // Fallback: no deletion snapshot found (e.g. note was deleted via sync).
    // If the note is in the trash, remove the trash placement and clear
    // deleted_at. If it has no other placements, place it at the root.
    const trashPlacements = this.store.sqlite
      .prepare("SELECT id FROM placements WHERE note_id=? AND parent_placement_id=?")
      .all(noteId, SYSTEM_TRASH_PLACEMENT_ID) as Array<{ id: string }>;
    if (trashPlacements.length > 0) {
      const t = now();
      this.store.sqlite.transaction(() => {
        // Delete trash placements.
        for (const p of trashPlacements) {
          this.store.sqlite
            .prepare("DELETE FROM placements WHERE id=?")
            .run(p.id);
        }
        this.store.sqlite
          .prepare("UPDATE notes SET deleted_at=NULL,updated_at=? WHERE id=?")
          .run(t, noteId);
        // If the note has no remaining placements, place it at the root.
        let newRootPlacementId: string | null = null;
        const remaining = this.store.sqlite
          .prepare("SELECT 1 FROM placements WHERE note_id=?")
          .get(noteId);
        if (!remaining) {
          const position = (
            this.store.sqlite
              .prepare("SELECT COALESCE(MAX(position),-1)+1 p FROM placements WHERE parent_placement_id=?")
              .get(SYSTEM_ROOT_PLACEMENT_ID) as { p: number }
          ).p;
          newRootPlacementId = id();
          this.store.sqlite
            .prepare("INSERT INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)")
            .run(newRootPlacementId, noteId, SYSTEM_ROOT_PLACEMENT_ID, position, t, t);
        }
        // Record all changes for sync so other devices learn about the
        // placement deletions and optional creation.
        const changes: Array<{
          entityType: string;
          entityId: string;
          changeKind: ChangeKind;
        }> = [
          ...trashPlacements.map((p) => ({
            entityType: "placement" as const,
            entityId: p.id,
            changeKind: "deleted" as const,
          })),
          { entityType: "note", entityId: noteId, changeKind: "updated" },
        ];
        if (newRootPlacementId) {
          changes.push({
            entityType: "placement",
            entityId: newRootPlacementId,
            changeKind: "created",
          });
        }
        recordChanges(this.store.sqlite, changes);
      })();
      this.rebuildSearchIndex(noteId);
      return { undoId: null };
    }
    throw new NotFoundError("No restorable deletion record found for this note");
  }
  /** Permanently removes a note and lets SQLite cascade metadata rows. */
  purge(noteId: string) {
    this.assertNotSystemNote(noteId);
    this.store.sqlite.transaction(() => {
      const result = this.store.sqlite.prepare("DELETE FROM notes WHERE id=?").run(noteId);
      if (!result.changes) throw new NotFoundError();
      recordChange(this.store.sqlite, "note", noteId, "deleted", now());
      this.queueUnreferencedAttachmentCleanup();
    })();
    // The storage adapter owns physical files. The durable job records cleanup intent;
    // keys are retained for compatibility with existing API callers.
    return { attachmentStorageKeys: [] };
  }
  /** Permanently deletes every note currently in the trash. */
  purgeTrash(before?: number) {
    const noteIds = (
      this.store.sqlite
        .prepare(
          `SELECT DISTINCT n.id FROM notes n
         WHERE n.deleted_at IS NOT NULL
           AND n.id NOT IN (?,?)
           AND (? IS NULL OR n.deleted_at <= ?)`,
        )
        .all(SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, before ?? null, before ?? null) as IdRow[]
    ).map((row) => row.id as string);
    this.store.sqlite.transaction(() => {
      for (const noteId of noteIds) {
        this.store.sqlite.prepare("DELETE FROM notes WHERE id=?").run(noteId);
        recordChange(this.store.sqlite, "note", noteId, "deleted", now());
      }
      this.queueUnreferencedAttachmentCleanup();
    })();
    return { count: noteIds.length, attachmentStorageKeys: [] };
  }
  tree() {
    const rows = this.store.sqlite
      .prepare(
        `SELECT p.id placementId,p.note_id noteId,p.parent_placement_id parentPlacementId,p.position,n.title,n.content_data contentData,n.content_codec contentCodec,n.is_protected isProtected,n.type,
                n.deleted_at IS NOT NULL isTrashed, n.archived_at IS NOT NULL isArchived, n.id IN (?,?) isSystem, n.id=? isCalendar, p.id=? isTrash
         FROM placements p JOIN notes n ON p.note_id=n.id
         WHERE (n.deleted_at IS NULL OR p.parent_placement_id=?)
         ORDER BY p.parent_placement_id,p.position`,
      )
      .all(
        SYSTEM_ROOT_NOTE_ID,
        SYSTEM_TRASH_NOTE_ID,
        CALENDAR_NOTE_ID,
        SYSTEM_TRASH_PLACEMENT_ID,
        SYSTEM_TRASH_PLACEMENT_ID,
      ) as TreeRow[];
    return rows.map(({ contentData, contentCodec, ...row }) =>
      row.isProtected
        ? { ...row, contentJson: decodeStoredContent(contentData, contentCodec as ContentCodec) }
        : row,
    );
  }
  children(parent: string) {
    return this.store.sqlite
      .prepare(
        "SELECT p.id placementId,p.note_id noteId,p.parent_placement_id parentPlacementId,p.position,n.title,n.type,n.deleted_at IS NOT NULL isTrashed,n.archived_at IS NOT NULL isArchived,n.id IN (?,?) isSystem,p.id=? isTrash FROM placements p JOIN notes n ON p.note_id=n.id WHERE p.parent_placement_id IS ? AND (n.deleted_at IS NULL OR p.parent_placement_id=?) ORDER BY p.position",
      )
      .all(
        SYSTEM_ROOT_NOTE_ID,
        SYSTEM_TRASH_NOTE_ID,
        SYSTEM_TRASH_PLACEMENT_ID,
        parent,
        SYSTEM_TRASH_PLACEMENT_ID,
      );
  }
  /**
   * Returns both the logical document size and the stored content payload size
   * for a placement and its subtree. Attachments are counted once per note set,
   * even when shared or cloned. Stored payload sizes intentionally exclude
   * SQLite pages, indexes, WAL, and other database-level overhead.
   */
  sizeForPlacement(placementId: string) {
    const own = this.store.sqlite
      .prepare(
        `SELECT LENGTH(CAST(n.title AS BLOB)) + n.content_size + LENGTH(CAST(n.properties_json AS BLOB)) contentBytes,
                LENGTH(CAST(n.title AS BLOB)) + LENGTH(n.content_data) + LENGTH(CAST(n.properties_json AS BLOB)) storedContentBytes,
                0 attachmentBytes
         FROM placements p
         JOIN notes n ON n.id=p.note_id
         WHERE p.id=?
         GROUP BY p.id`,
      )
      .get(placementId) as
      { contentBytes: number; storedContentBytes: number; attachmentBytes: number } | undefined;
    if (!own) throw new NotFoundError("Placement not found");
    const ownNoteId = (this.store.sqlite
      .prepare("SELECT note_id id FROM placements WHERE id=?")
      .get(placementId) as IdRow).id as string;
    own.attachmentBytes = this.attachmentBytesForNotes([ownNoteId]);

    const subtree = this.store.sqlite
      .prepare(
        `WITH RECURSIVE subtree(placement_id,note_id) AS (
           SELECT id,note_id FROM placements WHERE id=?
           UNION ALL
           SELECT p.id,p.note_id FROM placements p JOIN subtree s ON p.parent_placement_id=s.placement_id
         ),
         subtree_notes AS (SELECT DISTINCT note_id FROM subtree)
         SELECT
           (SELECT COUNT(*) FROM subtree_notes) noteCount,
           COALESCE((SELECT SUM(LENGTH(CAST(n.title AS BLOB)) + n.content_size + LENGTH(CAST(n.properties_json AS BLOB))) FROM notes n JOIN subtree_notes sn ON sn.note_id=n.id), 0) contentBytes,
           COALESCE((SELECT SUM(LENGTH(CAST(n.title AS BLOB)) + LENGTH(n.content_data) + LENGTH(CAST(n.properties_json AS BLOB))) FROM notes n JOIN subtree_notes sn ON sn.note_id=n.id), 0) storedContentBytes,
           0 attachmentBytes`,
      )
      .get(placementId) as {
      noteCount: number;
      contentBytes: number;
      storedContentBytes: number;
      attachmentBytes: number;
    };
    const subtreeNoteIds = (this.store.sqlite
      .prepare(
        `WITH RECURSIVE subtree(id,note_id) AS (
           SELECT id,note_id FROM placements WHERE id=?
           UNION ALL
           SELECT p.id,p.note_id FROM placements p JOIN subtree s ON p.parent_placement_id=s.id
         ) SELECT DISTINCT note_id id FROM subtree`,
      )
      .all(placementId) as IdRow[]).map((row) => row.id as string);
    subtree.attachmentBytes = this.attachmentBytesForNotes(subtreeNoteIds);

    return {
      note: {
        ...own,
        totalBytes: own.contentBytes + own.attachmentBytes,
        storedTotalBytes: own.storedContentBytes + own.attachmentBytes,
      },
      subtree: {
        ...subtree,
        totalBytes: subtree.contentBytes + subtree.attachmentBytes,
        storedTotalBytes: subtree.storedContentBytes + subtree.attachmentBytes,
      },
    };
  }

  /** Attachment ownership is derived from note JSON. Count each referenced
   * attachment once for the requested note set, including shared images. */
  private attachmentBytesForNotes(noteIds: string[]) {
    const attachmentIds = new Set<string>();
    const readNote = this.store.sqlite.prepare(
      "SELECT content_data contentData,content_codec contentCodec,is_protected isProtected FROM notes WHERE id=?",
    );
    for (const noteId of noteIds) {
      const row = readNote.get(noteId) as
        | { contentData: Buffer; contentCodec: ContentCodec; isProtected: number }
        | undefined;
      if (!row || row.isProtected) continue;
      const content = decodeStoredContent(row.contentData, row.contentCodec);
      for (const match of content.matchAll(/\/api\/v1\/attachments\/([0-9a-f-]{36})(?:["'?/#]|$)/gi))
        attachmentIds.add(match[1]);
    }
    const readSize = this.store.sqlite.prepare("SELECT size FROM attachments WHERE id=?");
    let total = 0;
    for (const attachmentId of attachmentIds) {
      const row = readSize.get(attachmentId) as { size: number } | undefined;
      total += row?.size ?? 0;
    }
    return total;
  }

  private queueUnreferencedAttachmentCleanup() {
    const referenced = new Set<string>();
    const noteRows = this.store.sqlite
      .prepare("SELECT content_data contentData,content_codec contentCodec FROM notes WHERE is_protected=0 AND type<>'code'")
      .all() as Array<{ contentData: Buffer; contentCodec: ContentCodec }>;
    for (const row of noteRows) {
      const content = decodeStoredContent(row.contentData, row.contentCodec);
      for (const match of content.matchAll(/\/api\/v1\/attachments\/([0-9a-f-]{36})(?:["'?/#]|$)/gi))
        referenced.add(match[1]);
    }
    const attachments = this.store.sqlite
      .prepare("SELECT id,storage_key storageKey FROM attachments")
      .all() as Array<{ id: string; storageKey: string }>;
    const t = now();
    for (const attachment of attachments) {
      if (referenced.has(attachment.id)) continue;
      this.store.sqlite.prepare("DELETE FROM attachments WHERE id=?").run(attachment.id);
      this.store.sqlite
        .prepare("INSERT OR IGNORE INTO storage_cleanup_jobs(id,storage_key,reason,attempts,created_at) VALUES (?,?,?,?,?)")
        .run(id(), attachment.storageKey, "note-purged", 0, t);
      recordChange(this.store.sqlite, "attachment", attachment.id, "deleted");
    }
  }
  addPlacement(noteId: string, parentPlacementId: string, position?: number) {
    if (!this.get(noteId)) throw new NotFoundError("Note not found");
    if (
      noteId === SYSTEM_ROOT_NOTE_ID ||
      noteId === SYSTEM_TRASH_NOTE_ID ||
      noteId === CALENDAR_NOTE_ID
    )
      throw new ConflictError("System notes cannot be cloned");
    this.assertParent(parentPlacementId);
    this.assertCanUseAsNormalParent(parentPlacementId);
    const t = now(),
      placementId = id();
    const next =
      position ??
      (
        this.store.sqlite
          .prepare(
            "SELECT COALESCE(MAX(position),-1)+1 p FROM placements WHERE parent_placement_id IS ?",
          )
          .get(parentPlacementId) as PositionRow | undefined
      )?.p ??
      0;
    this.store.sqlite
      .prepare("INSERT INTO placements VALUES (?,?,?,?,?,?)")
      .run(placementId, noteId, parentPlacementId, next, t, t);
    recordChange(this.store.sqlite, "placement", placementId, "created");
    return { id: placementId, noteId, parentPlacementId, position: next };
  }
  movePlacement(placementId: string, parentPlacementId: string, position: number) {
    this.movePlacements([placementId], parentPlacementId, position);
  }
  movePlacements(placementIds: string[], parentPlacementId: string, position: number) {
    const uniquePlacementIds = [...new Set(placementIds)];
    if (!uniquePlacementIds.length) throw new ConflictError("At least one placement is required");
    uniquePlacementIds.forEach((placementId) => this.assertNotSystemPlacement(placementId));
    this.store.sqlite.transaction(() => {
      const existing = this.store.sqlite
        .prepare(`SELECT id FROM placements WHERE id IN (${uniquePlacementIds.map(() => "?").join(",")})`)
        .all(...uniquePlacementIds) as Array<{ id: string }>;
      if (existing.length !== uniquePlacementIds.length)
        throw new NotFoundError("Placement not found");
      this.assertParent(parentPlacementId);
      this.assertCanUseAsNormalParent(parentPlacementId);
      if (uniquePlacementIds.some((placementId) => placementId === parentPlacementId || this.isDescendant(parentPlacementId, placementId)))
        throw new ConflictError(
          "A placement cannot be moved into itself or one of its descendants",
        );
      // `position` is an insertion index among the destination siblings.  Re-numbering
      // normal siblings keeps ordering deterministic after moves and inserts. System
      // placements use reserved negative positions and are protected from updates.
      const siblings = this.store.sqlite
        .prepare(
          `SELECT id FROM placements WHERE parent_placement_id=? AND id NOT IN (${uniquePlacementIds.map(() => "?").join(",")}) AND note_id NOT IN (?,?,?) ORDER BY position,id`,
        )
        .all(
          parentPlacementId,
          ...uniquePlacementIds,
          SYSTEM_ROOT_NOTE_ID,
          SYSTEM_TRASH_NOTE_ID,
          CALENDAR_NOTE_ID,
        ) as Array<{ id: string }>;
      const insertionIndex = Math.min(position, siblings.length);
      const orderedIds = [
        ...siblings.slice(0, insertionIndex).map((sibling) => sibling.id),
        ...uniquePlacementIds,
        ...siblings.slice(insertionIndex).map((sibling) => sibling.id),
      ];
      const update = this.store.sqlite.prepare(
        "UPDATE placements SET parent_placement_id=?,position=?,updated_at=? WHERE id=?",
      );
      const updatedAt = now();
      orderedIds.forEach((id, index) => update.run(parentPlacementId, index, updatedAt, id));
      // A move re-numbers the entire sibling list. Sync that list as one
      // atomic entity instead of emitting only the dragged placement.
      this.store.sqlite
        .prepare("INSERT INTO placement_order_versions(parent_placement_id,updated_at) VALUES (?,?) ON CONFLICT(parent_placement_id) DO UPDATE SET updated_at=excluded.updated_at")
        .run(parentPlacementId, updatedAt);
      // The order snapshot only describes siblings already under the destination.
      // Record every moved placement so peers receive their new parent ids.
      for (const placementId of uniquePlacementIds)
        recordChange(this.store.sqlite, "placement", placementId, "updated");
      recordChange(this.store.sqlite, "placement-order", parentPlacementId, "updated");
    })();
  }
  deletePlacement(placementId: string) {
    this.assertNotSystemPlacement(placementId);
    const undoId = id();
    this.store.sqlite.transaction(() => {
      const placements = this.placementSubtree(placementId);
      if (!placements.length) throw new NotFoundError("Placement not found");
      const affected = [...new Set(placements.map((placement) => placement.noteId))];
      this.store.sqlite.prepare("DELETE FROM placements WHERE id=?").run(placementId);
      const autoTrashedNoteIds = this.moveOrphanNotesToTrash(affected);
      const snapshot: PlacementSnapshot = { placements, autoTrashedNoteIds };
      this.recordPlacementDeletion(undoId, snapshot);
      for (const placement of placements)
        recordChange(this.store.sqlite, "placement", placement.id, "deleted");
      for (const noteId of autoTrashedNoteIds)
        recordChange(this.store.sqlite, "note", noteId, "deleted", now());
    })();
    return { undoId };
  }
  /** Removes expired undo snapshots and caps the remaining recent records. */
  prunePlacementDeletions(
    maxRecords = PLACEMENT_DELETION_MAX_RECORDS,
    retentionMs = PLACEMENT_DELETION_RETENTION_MS,
  ) {
    const keep = Math.max(0, Math.floor(maxRecords));
    const cutoff = now() - Math.max(0, retentionMs);
    return this.store.sqlite
      .prepare(
        `DELETE FROM placement_deletions
         WHERE created_at < ?
            OR id IN (
              SELECT id FROM placement_deletions
              ORDER BY created_at DESC
              LIMIT -1 OFFSET ?
            )`,
      )
      .run(cutoff, keep).changes;
  }
  private recordPlacementDeletion(undoId: string, snapshot: PlacementSnapshot) {
    this.store.sqlite
      .prepare(
        "INSERT INTO placement_deletions (id,snapshot_json,created_at,undone_at) VALUES (?,?,?,NULL)",
      )
      .run(undoId, JSON.stringify(snapshot), now());
    this.prunePlacementDeletions();
  }
  undoPlacementDeletion(undoId: string) {
    const record = this.store.sqlite
      .prepare("SELECT snapshot_json FROM placement_deletions WHERE id=? AND undone_at IS NULL")
      .get(undoId) as { snapshot_json: string } | undefined;
    if (!record) throw new NotFoundError("Undo record not found or already used");
    const snapshot = JSON.parse(record.snapshot_json) as PlacementSnapshot;
    if (!Array.isArray(snapshot.placements) || !Array.isArray(snapshot.autoTrashedNoteIds))
      throw new ConflictError("Invalid placement undo snapshot");
    this.store.sqlite.transaction(() => {
      const snapshotIds = new Set(snapshot.placements.map((placement) => placement.id));
      for (const placement of snapshot.placements) {
        if (this.store.sqlite.prepare("SELECT 1 FROM placements WHERE id=?").get(placement.id))
          throw new ConflictError("A placement from this deletion has already been recreated");
      }
      for (const noteId of snapshot.autoTrashedNoteIds) {
        this.store.sqlite
          .prepare("DELETE FROM placements WHERE note_id=? AND parent_placement_id=?")
          .run(noteId, SYSTEM_TRASH_PLACEMENT_ID);
        this.store.sqlite
          .prepare("UPDATE notes SET deleted_at=NULL,updated_at=? WHERE id=?")
          .run(now(), noteId);
      }
      const insert = this.store.sqlite.prepare(
        "INSERT INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      );
      for (const placement of snapshot.placements) {
        const parentPlacementId =
          placement.parentPlacementId && !snapshotIds.has(placement.parentPlacementId)
            ? this.normalParentExists(placement.parentPlacementId)
              ? placement.parentPlacementId
              : SYSTEM_ROOT_PLACEMENT_ID
            : placement.parentPlacementId;
        insert.run(
          placement.id,
          placement.noteId,
          parentPlacementId,
          placement.position,
          placement.createdAt,
          placement.updatedAt,
        );
      }
      this.store.sqlite
        .prepare("UPDATE placement_deletions SET undone_at=? WHERE id=? AND undone_at IS NULL")
        .run(now(), undoId);
      for (const noteId of snapshot.autoTrashedNoteIds) this.rebuildSearchIndex(noteId);
      recordChanges(this.store.sqlite, [
        ...snapshot.autoTrashedNoteIds.map((id: string) => ({
          entityType: "note",
          entityId: id,
          changeKind: "updated" as const,
        })),
        ...snapshot.placements.map((p) => ({
          entityType: "placement",
          entityId: p.id,
          changeKind: "created" as const,
        })),
      ]);
    })();
    return { undoId };
  }
}
