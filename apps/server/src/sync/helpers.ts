import { randomUUID } from "node:crypto";
import {
  decodeStoredContent,
  recordChange,
  type ChangeKind,
  type ContentCodec,
  type SqliteDatabase,
} from "@ygdria/database";
import { CALENDAR_NOTE_ID, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, SYSTEM_TRASH_PLACEMENT_ID } from "@ygdria/shared";
import { isSensitiveSettingKey } from "../http/settings.js";

export type SyncSqlite = SqliteDatabase;

export type SyncEntityChange = {
  changeId: number;
  entityType: string;
  entityId: string;
  changeKind: string;
  data: Record<string, unknown> | null;
  createdAt?: number;
};

/**
 * Resolve a list of SyncChange entries into full entity snapshots for the
 * incremental sync response. Returns the current state of each entity.
 * Deleted entities are returned as tombstones.
 */
export function resolveChangeEntities(
  sqlite: SyncSqlite,
  attachmentRoot: string,
  changes: Array<{
    id: number;
    entityType: string;
    entityId: string;
    changeKind: string;
    createdAt: number;
  }>,
  includeNoteContent = true,
): Array<{
  changeId: number;
  entityType: string;
  entityId: string;
  changeKind: string;
  createdAt: number;
  data: Record<string, unknown> | null;
}> {
  const result: Array<{
    changeId: number;
    entityType: string;
    entityId: string;
    changeKind: string;
    createdAt: number;
    data: Record<string, unknown> | null;
  }> = [];
  for (const change of changes) {
    if (change.entityType === "setting" && isSensitiveSettingKey(change.entityId)) continue;
    let data: Record<string, unknown> | null = null;
    if (change.changeKind === "deleted") {
      result.push({
        changeId: change.id,
        entityType: change.entityType,
        entityId: change.entityId,
        changeKind: change.changeKind,
        createdAt: change.createdAt,
        data: null,
      });
      continue;
    }
    switch (change.entityType) {
      case "note": {
        const row = sqlite
          .prepare(
            "SELECT id,title,type,content_data,content_codec,content_size,content_hash,plain_text,is_protected,properties_json,version,deleted_at,archived_at,created_at,updated_at FROM notes WHERE id=?",
          )
          .get(change.entityId) as
          | {
              id: string;
              title: string;
              type: string;
              content_data: Buffer;
              content_codec: string;
              content_size: number;
              content_hash: string;
              plain_text: string;
              is_protected: number;
              properties_json: string;
              version: number;
              deleted_at: number | null;
              archived_at: number | null;
              created_at: number;
              updated_at: number;
            }
          | undefined;
        if (row) {
          const attachmentRefs = row.is_protected ? [] : attachmentIdsFromStoredContent(row.content_data, row.content_codec as ContentCodec)
            .map((id) => sqlite.prepare("SELECT id,filename,content_hash contentHash FROM attachments WHERE id=?").get(id) as { id: string; filename: string; contentHash: string } | undefined)
            .filter((value): value is { id: string; filename: string; contentHash: string } => Boolean(value));
          data = {
            id: row.id,
            title: row.title,
            type: row.type,
            ...(includeNoteContent ? { contentData: Buffer.from(row.content_data).toString("base64") } : {}),
            contentCodec: row.content_codec,
            contentSize: row.content_size,
            contentHash: row.content_hash,
            ...(includeNoteContent ? { plainText: row.plain_text } : {}),
            propertiesJson: row.properties_json,
            isProtected: Boolean(row.is_protected),
            version: row.version,
            deletedAt: row.deleted_at,
            archivedAt: row.archived_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            attachmentRefs,
          };
        }
        break;
      }
      case "placement": {
        const row = sqlite
          .prepare(
            "SELECT id,note_id noteId,parent_placement_id parentPlacementId,position,created_at createdAt,updated_at updatedAt FROM placements WHERE id=?",
          )
          .get(change.entityId) as
          | {
              id: string;
              noteId: string;
              parentPlacementId: string | null;
              position: number;
              createdAt: number;
              updatedAt: number;
            }
          | undefined;
        if (row) data = row;
        break;
      }
      case "placement-order": {
        const version = sqlite.prepare("SELECT updated_at updatedAt FROM placement_order_versions WHERE parent_placement_id=?").get(change.entityId) as { updatedAt: number } | undefined;
        if (version) {
          const placementIds = (sqlite.prepare(
            "SELECT id FROM placements WHERE parent_placement_id=? AND note_id NOT IN (?,?,?) ORDER BY position,id",
          ).all(change.entityId, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID) as Array<{ id: string }>).map((row) => row.id);
          data = { parentPlacementId: change.entityId, placementIds, updatedAt: version.updatedAt };
        }
        break;
      }
      case "attachment": {
        const row = sqlite
          .prepare(
            "SELECT id,filename,mime_type mimeType,size,storage_key storageKey,content_hash contentHash,created_at createdAt FROM attachments WHERE id=?",
          )
          .get(change.entityId) as
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
        if (row) data = { ...row, dataBase64: "" };
        break;
      }
      case "revision": {
        const row = sqlite
          .prepare(
            "SELECT id,note_id noteId,content_data contentData,content_codec contentCodec,content_hash contentHash,created_at createdAt FROM revisions WHERE id=?",
          )
          .get(change.entityId) as
          | {
              id: string;
              noteId: string;
              contentData: Buffer;
              contentCodec: string;
              contentHash: string;
              createdAt: number;
            }
          | undefined;
        if (row) data = { ...row, contentData: Buffer.from(row.contentData).toString("base64") };
        break;
      }
      case "setting": {
        const row = sqlite
          .prepare("SELECT key,value,updated_at updatedAt FROM settings WHERE key=?")
          .get(change.entityId) as { key: string; value: string; updatedAt: number } | undefined;
        if (row) data = row;
        break;
      }
      case "relation": {
        const row = sqlite
          .prepare(
            "SELECT id,source_note_id sourceNoteId,target_note_id targetNoteId,relation_type relationType,created_at createdAt FROM relations WHERE id=?",
          )
          .get(change.entityId) as
          | { id: string; sourceNoteId: string; targetNoteId: string; relationType: string; createdAt: number }
          | undefined;
        if (row) data = row;
        break;
      }
      default:
        break;
    }
    result.push({
      changeId: change.id,
      entityType: change.entityType,
      entityId: change.entityId,
      changeKind: data ? change.changeKind : "deleted",
      createdAt: change.createdAt,
      data,
    });
  }
  return result;
}

export function attachmentIdsFromStoredContent(data: Buffer, codec: ContentCodec): string[] {
  const ids = new Set<string>();
  const content = decodeStoredContent(data, codec);
  for (const match of content.matchAll(/\/api\/v1\/attachments\/([0-9a-f-]{36})(?:["'?/#]|$)/gi)) ids.add(match[1]);
  return [...ids];
}

export function fullSnapshotChanges(sqlite: SyncSqlite) {
  const changes: Array<{ id: number; entityType: string; entityId: string; changeKind: string; createdAt: number }> = [];
  let id = 0;
  for (const row of sqlite.prepare("SELECT id,updated_at updatedAt FROM notes WHERE deleted_at IS NULL ORDER BY created_at,id").all() as Array<{ id: string; updatedAt: number }>)
    changes.push({ id: ++id, entityType: "note", entityId: row.id, changeKind: "updated", createdAt: row.updatedAt });
  const pending = new Map((sqlite.prepare("SELECT id,parent_placement_id parentPlacementId,updated_at updatedAt FROM placements").all() as Array<{ id: string; parentPlacementId: string | null; updatedAt: number }>).map((row) => [row.id, row]));
  while (pending.size) {
    let progressed = false;
    for (const [placementId, row] of pending) {
      if (row.parentPlacementId && pending.has(row.parentPlacementId)) continue;
      changes.push({ id: ++id, entityType: "placement", entityId: placementId, changeKind: "updated", createdAt: row.updatedAt });
      pending.delete(placementId); progressed = true;
    }
    if (!progressed) throw Object.assign(new Error("Placement hierarchy contains a cycle"), { statusCode: 409 });
  }
  for (const row of sqlite.prepare("SELECT id,created_at createdAt FROM revisions ORDER BY created_at,id").all() as Array<{ id: string; createdAt: number }>)
    changes.push({ id: ++id, entityType: "revision", entityId: row.id, changeKind: "created", createdAt: row.createdAt });
  for (const row of sqlite.prepare("SELECT id,source_note_id sourceNoteId,target_note_id targetNoteId,relation_type relationType,created_at createdAt FROM relations ORDER BY created_at,id").all() as Array<{ id: string; createdAt: number }>)
    changes.push({ id: ++id, entityType: "relation", entityId: row.id, changeKind: "created", createdAt: row.createdAt });
  for (const row of sqlite.prepare("SELECT key,updated_at updatedAt FROM settings ORDER BY key").all() as Array<{ key: string; updatedAt: number }>)
    if (!isSensitiveSettingKey(row.key)) changes.push({ id: ++id, entityType: "setting", entityId: row.key, changeKind: "updated", createdAt: row.updatedAt });
  return changes;
}

/** Build a complete, dependency-ordered baseline without exposing note bodies
 * outside the existing sync protocol. Placements must follow their parent so
 * a fresh receiver never violates its parent_placement_id foreign key. */
export function rebuildSyncBaseline(sqlite: SyncSqlite) {
  const noteIds = (sqlite.prepare("SELECT id FROM notes").all() as Array<{ id: string }>).map((row) => row.id);
  const placementRows = sqlite
    .prepare("SELECT id,parent_placement_id parentPlacementId FROM placements")
    .all() as Array<{ id: string; parentPlacementId: string | null }>;
  const pending = new Map(placementRows.map((row) => [row.id, row]));
  const placementIds: string[] = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, row] of pending) {
      if (row.parentPlacementId !== null && pending.has(row.parentPlacementId)) continue;
      placementIds.push(id);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) {
      placementIds.push(...pending.keys());
      break;
    }
  }
  const revisionIds = (sqlite.prepare("SELECT id FROM revisions").all() as Array<{ id: string }>).map((row) => row.id);
  const relationIds = (sqlite.prepare("SELECT id FROM relations").all() as Array<{ id: string }>).map((row) => row.id);
  const settingIds = (sqlite.prepare("SELECT key FROM settings").all() as Array<{ key: string }>)
    .map((row) => row.key)
    .filter((key) => !isSensitiveSettingKey(key));
  sqlite.transaction(() => {
    for (const id of noteIds) recordChange(sqlite, "note", id, "updated");
    for (const id of placementIds) recordChange(sqlite, "placement", id, "updated");
    for (const id of revisionIds) recordChange(sqlite, "revision", id, "created");
    for (const id of relationIds) recordChange(sqlite, "relation", id, "created");
    for (const id of settingIds) recordChange(sqlite, "setting", id, "updated");
  })();
  return { notes: noteIds.length, placements: placementIds.length, revisions: revisionIds.length, relations: relationIds.length, settings: settingIds.length };
}

/** Keep the external-content FTS projection consistent when sync bypasses the
 * domain service and writes notes directly. These helpers must be called in
 * the same transaction as the corresponding note change. */
export function removeNoteFromSearchIndex(sqlite: SyncSqlite, noteId: string) {
  sqlite
    .prepare(
      "INSERT INTO notes_fts(notes_fts,rowid,title,plain_text,properties_json) SELECT 'delete',rowid,title,plain_text,properties_json FROM notes WHERE id=? AND is_protected=0 AND deleted_at IS NULL",
    )
    .run(noteId);
}

export function addNoteToSearchIndex(sqlite: SyncSqlite, noteId: string) {
  sqlite
    .prepare(
      "INSERT INTO notes_fts(rowid,title,plain_text,properties_json) SELECT rowid,title,plain_text,properties_json FROM notes WHERE id=? AND is_protected=0 AND deleted_at IS NULL",
    )
    .run(noteId);
}

export function noteWouldAcceptSyncUpdate(sqlite: SyncSqlite, noteId: string, timestamp: number) {
  const current = sqlite
    .prepare("SELECT updated_at updatedAt FROM notes WHERE id=?")
    .get(noteId) as { updatedAt: number } | undefined;
  return !current || timestamp > current.updatedAt;
}

export function cleanupUnreferencedSyncAttachments(sqlite: SyncSqlite, candidates: Set<string>, recordOutbound: boolean) {
  if (candidates.size === 0) return;
  const referenced = new Set<string>();
  const notes = sqlite
    .prepare("SELECT content_data contentData,content_codec contentCodec FROM notes WHERE is_protected=0 AND type<>'code'")
    .all() as Array<{ contentData: Buffer; contentCodec: ContentCodec }>;
  try {
    for (const note of notes)
      for (const attachmentId of attachmentIdsFromStoredContent(note.contentData, note.contentCodec))
        referenced.add(attachmentId);
  } catch {
    return;
  }
  const attachments = sqlite
    .prepare("SELECT id,storage_key storageKey FROM attachments")
    .all() as Array<{ id: string; storageKey: string }>;
  const timestamp = Date.now();
  for (const attachment of attachments) {
    if (!candidates.has(attachment.id) || referenced.has(attachment.id)) continue;
    sqlite.prepare("DELETE FROM attachments WHERE id=?").run(attachment.id);
    sqlite
      .prepare("INSERT OR IGNORE INTO storage_cleanup_jobs(id,storage_key,reason,attempts,created_at) VALUES (?,?,?,?,?)")
      .run(randomUUID(), attachment.storageKey, "sync-reference-removed", 0, timestamp);
    if (recordOutbound) recordChange(sqlite, "attachment", attachment.id, "deleted");
  }
}

/** A change that was NOT applied because last-write-wins rejected it: the local
 * entity was newer than the incoming record. Surfaced so clients can flag a
 * sync divergence instead of silently losing the losing side's edit. */
export type RejectedSyncChange = {
  entityType: string;
  entityId: string;
  localUpdatedAt: number;
  localVersion: number;
};

/** Apply peer records with strict timestamp comparison so echoed records do
 * not create an endless sync loop. Attachments themselves are copied through
 * the by-hash endpoint after their owning note has been accepted. */
export function applySyncChanges(sqlite: SyncSqlite, changes: SyncEntityChange[], recordOutbound = true): { applied: number; rejected: RejectedSyncChange[] } {
  let applied = 0;
  const rejected: RejectedSyncChange[] = [];
  const attachmentCleanupCandidates = new Set<string>();
  const logChange = (entityType: string, entityId: string, changeKind: ChangeKind) => {
    if (recordOutbound) recordChange(sqlite, entityType, entityId, changeKind);
  };
  const ordered = [...changes].sort((a, b) => {
    const rank = (type: string) => type === "note" ? 0 : type === "placement" ? 1 : type === "placement-order" ? 2 : 3;
    return rank(a.entityType) - rank(b.entityType);
  });
  sqlite.transaction(() => {
    for (const change of ordered) {
      if (change.entityType === "setting" && isSensitiveSettingKey(change.entityId)) continue;
      const timestamp = Number(
        change.createdAt ?? (change.data as { updatedAt?: number } | null)?.updatedAt ?? 0,
      );
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) continue;
      if (change.entityType === "attachment" && change.changeKind === "deleted") {
        // Explicit attachment deletions are reconciled through the same
        // reference-aware cleanup used for content-driven removals, so a peer
        // only drops the metadata row when nothing local still references it.
        attachmentCleanupCandidates.add(change.entityId);
        continue;
      }
      if (change.entityType === "note") {
        if (change.changeKind === "deleted") {
          const accepts = noteWouldAcceptSyncUpdate(sqlite, change.entityId, timestamp);
          if (accepts) removeNoteFromSearchIndex(sqlite, change.entityId);
          const existing = sqlite
            .prepare("SELECT deleted_at deletedAt FROM notes WHERE id=?")
            .get(change.entityId) as { deletedAt: number | null } | undefined;
          if (existing && existing.deletedAt !== null && accepts) {
            // The peer no longer has this note (it purged its trash) and the note
            // is already in our trash, so hard-delete it locally to keep the two
            // databases as consistent as possible. Safe: the note is already
            // trashed here, so no user-visible content is lost, and a later
            // restore from the peer would re-insert it via the note upsert below.
            sqlite.prepare("DELETE FROM notes WHERE id=?").run(change.entityId);
            logChange("note", change.entityId, "deleted");
            applied += 1;
            continue;
          }
          if (existing && accepts) {
            // Active locally: the peer deleted it but we still have it live (a
            // conflict, e.g. we restored after the peer trashed). Soft-delete to
            // trash so it stays recoverable rather than silently destroying
            // possibly-restored content.
            const result = sqlite
              .prepare(
                "UPDATE notes SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND updated_at < ?",
              )
              .run(timestamp, timestamp, change.entityId, timestamp);
            if (result.changes) {
              const hasTrashPlacement = sqlite
                .prepare("SELECT 1 FROM placements WHERE note_id=? AND parent_placement_id=?")
                .get(change.entityId, SYSTEM_TRASH_PLACEMENT_ID);
              if (!hasTrashPlacement) {
                const position = (
                  sqlite
                    .prepare("SELECT COALESCE(MAX(position),-1)+1 p FROM placements WHERE parent_placement_id=?")
                    .get(SYSTEM_TRASH_PLACEMENT_ID) as { p: number }
                ).p;
                sqlite
                  .prepare("INSERT OR IGNORE INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)")
                  .run(randomUUID(), change.entityId, SYSTEM_TRASH_PLACEMENT_ID, position, timestamp, timestamp);
              }
              logChange("note", change.entityId, "deleted");
              applied += 1;
            }
          }
          continue;
        }
        const d = change.data as Record<string, unknown> | null;
        if (!d || typeof d.contentData !== "string" || typeof d.updatedAt !== "number") continue;
        const acceptsUpdate = noteWouldAcceptSyncUpdate(sqlite, String(d.id), d.updatedAt);
        if (!acceptsUpdate) {
          // Local note is newer than the incoming record: last-write-wins keeps
          // ours and discards the peer's edit. Record it so the client can flag
          // the divergence instead of silently dropping the peer's change.
          const local = sqlite
            .prepare("SELECT updated_at updatedAt, version FROM notes WHERE id=?")
            .get(String(d.id)) as { updatedAt: number; version: number } | undefined;
          if (local) rejected.push({ entityType: "note", entityId: String(d.id), localUpdatedAt: local.updatedAt, localVersion: local.version });
          continue;
        }
        if (acceptsUpdate) {
          const previous = sqlite
            .prepare("SELECT content_data contentData,content_codec contentCodec,is_protected isProtected,type FROM notes WHERE id=?")
            .get(String(d.id)) as { contentData: Buffer; contentCodec: ContentCodec; isProtected: number; type: string } | undefined;
          if (previous && !previous.isProtected && previous.type !== "code") {
            try {
              for (const attachmentId of attachmentIdsFromStoredContent(previous.contentData, previous.contentCodec))
                attachmentCleanupCandidates.add(attachmentId);
            } catch { /* conservative cleanup helper will retain data on invalid documents */ }
          }
        }
        if (acceptsUpdate) removeNoteFromSearchIndex(sqlite, String(d.id));
        const result = sqlite
          .prepare(
            "INSERT INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,is_protected,properties_json,version,deleted_at,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,type=excluded.type,content_data=excluded.content_data,content_codec=excluded.content_codec,content_size=excluded.content_size,content_hash=excluded.content_hash,plain_text=excluded.plain_text,is_protected=excluded.is_protected,properties_json=excluded.properties_json,version=excluded.version,deleted_at=excluded.deleted_at,archived_at=excluded.archived_at,updated_at=excluded.updated_at WHERE excluded.updated_at > notes.updated_at",
          )
          .run(
            d.id,
            d.title,
            d.type,
            Buffer.from(d.contentData, "base64"),
            d.contentCodec,
            d.contentSize,
            d.contentHash,
            d.plainText,
            d.isProtected ? 1 : 0,
            d.propertiesJson,
            d.version,
            d.deletedAt,
            d.archivedAt,
            d.createdAt,
            d.updatedAt,
          );
        if (result.changes) {
          if (d.deletedAt === null) {
            const trashPlacements = sqlite
              .prepare("SELECT id FROM placements WHERE note_id=? AND parent_placement_id=?")
              .all(String(d.id), SYSTEM_TRASH_PLACEMENT_ID) as Array<{ id: string }>;
            const removePlacement = sqlite.prepare("DELETE FROM placements WHERE id=?");
            for (const placement of trashPlacements) {
              removePlacement.run(placement.id);
              logChange("placement", placement.id, "deleted");
            }
          }
          addNoteToSearchIndex(sqlite, String(d.id));
          logChange("note", String(d.id), "updated");
          applied += 1;
        }
      } else if (change.entityType === "placement-order") {
        const d = change.data as Record<string, unknown> | null;
        if (!d || typeof d.parentPlacementId !== "string" || !Array.isArray(d.placementIds) || !d.placementIds.every((id) => typeof id === "string") || typeof d.updatedAt !== "number") continue;
        const accepted = sqlite.prepare(
          "INSERT INTO placement_order_versions(parent_placement_id,updated_at) VALUES (?,?) ON CONFLICT(parent_placement_id) DO UPDATE SET updated_at=excluded.updated_at WHERE excluded.updated_at > placement_order_versions.updated_at",
        ).run(d.parentPlacementId, d.updatedAt);
        if (!accepted.changes) continue;
        const current = sqlite.prepare("SELECT id FROM placements WHERE parent_placement_id=? AND note_id NOT IN (?,?,?) ORDER BY position,id")
          .all(d.parentPlacementId, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID) as Array<{ id: string }>;
        const allowed = new Set(current.map((row) => row.id));
        const requested = [...new Set(d.placementIds)].filter((id): id is string => typeof id === "string" && allowed.has(id));
        const requestedSet = new Set(requested);
        const order = [...requested, ...current.map((row) => row.id).filter((id) => !requestedSet.has(id))];
        const update = sqlite.prepare("UPDATE placements SET position=?,updated_at=? WHERE id=? AND parent_placement_id=?");
        order.forEach((id, position) => update.run(position, d.updatedAt, id, d.parentPlacementId));
        logChange("placement-order", d.parentPlacementId, "updated");
        applied += 1;
      } else if (change.entityType === "placement") {
        if (change.changeKind === "deleted") {
          const result = sqlite
            .prepare("DELETE FROM placements WHERE id=? AND updated_at < ?")
            .run(change.entityId, timestamp);
          if (result.changes) {
            logChange("placement", change.entityId, "deleted");
            applied += 1;
          }
          continue;
        }
        const d = change.data as Record<string, unknown> | null;
        if (!d || typeof d.noteId !== "string" || typeof d.updatedAt !== "number") continue;
        const result = sqlite
          .prepare(
            "INSERT INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM notes WHERE id=?) ON CONFLICT(id) DO UPDATE SET note_id=excluded.note_id,parent_placement_id=excluded.parent_placement_id,position=excluded.position,updated_at=excluded.updated_at WHERE excluded.updated_at > placements.updated_at",
          )
          .run(
            d.id,
            d.noteId,
            d.parentPlacementId ?? null,
            d.position,
            d.createdAt,
            d.updatedAt,
            d.noteId,
          );
        if (result.changes) {
          logChange("placement", String(d.id), "updated");
          applied += 1;
        }
      } else if (change.entityType === "revision") {
        if (change.changeKind === "deleted") {
          const result = sqlite.prepare("DELETE FROM revisions WHERE id=?").run(change.entityId);
          if (result.changes) {
            logChange("revision", change.entityId, "deleted");
            applied += 1;
          }
          continue;
        }
        const d = change.data as Record<string, unknown> | null;
        if (
          !d ||
          typeof d.id !== "string" ||
          typeof d.noteId !== "string" ||
          typeof d.contentData !== "string" ||
          typeof d.contentCodec !== "string" ||
          typeof d.contentHash !== "string" ||
          typeof d.createdAt !== "number"
        )
          continue;
        const result = sqlite
          .prepare(
            "INSERT OR IGNORE INTO revisions (id,note_id,content_data,content_codec,content_hash,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM notes WHERE id=?)",
          )
          .run(
            d.id,
            d.noteId,
            Buffer.from(d.contentData, "base64"),
            d.contentCodec,
            d.contentHash,
            d.createdAt,
            d.noteId,
          );
        if (result.changes) {
          logChange("revision", String(d.id), "created");
          applied += 1;
        }
      } else if (change.entityType === "relation") {
        if (change.changeKind === "deleted") {
          // The AFTER DELETE trigger writes the sync tombstone automatically.
          const result = sqlite.prepare("DELETE FROM relations WHERE id=?").run(change.entityId);
          if (result.changes) {
            logChange("relation", change.entityId, "deleted");
            applied += 1;
          }
          continue;
        }
        const d = change.data as Record<string, unknown> | null;
        if (
          !d ||
          typeof d.id !== "string" ||
          typeof d.sourceNoteId !== "string" ||
          typeof d.targetNoteId !== "string" ||
          typeof d.relationType !== "string" ||
          typeof d.createdAt !== "number"
        )
          continue;
        // INSERT OR IGNORE keeps the edge idempotent; the anti-resurrection
        // guard refuses to recreate an edge a peer has since deleted, matching
        // the `setting` branch semantics. Both endpoints must already exist.
        const result = sqlite
          .prepare(
            "INSERT OR IGNORE INTO relations (id,source_note_id,target_note_id,relation_type,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM notes WHERE id=?) AND EXISTS(SELECT 1 FROM notes WHERE id=?) AND NOT EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type='relation' AND entity_id=? AND deleted_at>=?)",
          )
          .run(
            d.id,
            d.sourceNoteId,
            d.targetNoteId,
            d.relationType,
            d.createdAt,
            d.sourceNoteId,
            d.targetNoteId,
            d.id,
            d.createdAt,
          );
        if (result.changes) {
          logChange("relation", String(d.id), "created");
          applied += 1;
        }
      } else if (change.entityType === "setting") {
        if (change.changeKind === "deleted") {
          const result = sqlite
            .prepare("DELETE FROM settings WHERE key=? AND updated_at < ?")
            .run(change.entityId, timestamp);
          sqlite
            .prepare(
              "INSERT INTO sync_tombstones (entity_type,entity_id,deleted_at) VALUES ('setting',?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at WHERE excluded.deleted_at > sync_tombstones.deleted_at",
            )
            .run(change.entityId, timestamp);
          if (result.changes) {
            logChange("setting", change.entityId, "deleted");
            applied += 1;
          }
          continue;
        }
        const d = change.data as Record<string, unknown> | null;
        if (
          !d ||
          typeof d.key !== "string" ||
          typeof d.value !== "string" ||
          typeof d.updatedAt !== "number" ||
          d.key !== change.entityId ||
          isSensitiveSettingKey(d.key)
        )
          continue;
        const result = sqlite
          .prepare(
            "INSERT INTO settings (key,value,updated_at) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type='setting' AND entity_id=? AND deleted_at>=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE excluded.updated_at > settings.updated_at",
          )
          .run(d.key, d.value, d.updatedAt, d.key, d.updatedAt);
        if (result.changes) {
          logChange("setting", d.key, "updated");
          applied += 1;
        }
      }
    }
    cleanupUnreferencedSyncAttachments(sqlite, attachmentCleanupCandidates, recordOutbound);
  })();
  return { applied, rejected };
}

export function parseExpectedVersion(ifMatch: string | string[] | undefined) {
  const raw = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
  const version = Number(String(raw ?? "").replaceAll('"', ""));
  if (!Number.isInteger(version) || version < 1)
    throw Object.assign(new Error("If-Match must contain the current positive note version"), {
      statusCode: 400,
    });
  return version;
}
