import { randomUUID } from "node:crypto";
import {
  decodeStoredContent,
  recordChange,
  NEXT_CHANGE_LOG_ID_SQL,
  type ChangeKind,
  type ContentCodec,
  type SqliteDatabase,
} from "@ygdria/database";
import { attachmentIdsFromSerializedDocument, CALENDAR_NOTE_ID, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, SYSTEM_TRASH_PLACEMENT_ID } from "@ygdria/shared";
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

const NOTE_COLS =
  "id,title,type,content_data,content_codec,content_size,content_hash,plain_text,is_protected,properties_json,version,deleted_at,archived_at,created_at,updated_at";
const ATTACHMENT_COLS = "id,filename,content_hash contentHash";
const PLACEMENT_COLS = "id,note_id noteId,parent_placement_id parentPlacementId,position,created_at createdAt,updated_at updatedAt";
const ATTACHMENT_FULL_COLS = "id,filename,mime_type mimeType,size,storage_key storageKey,content_hash contentHash,created_at createdAt";
const REVISION_COLS = "id,note_id noteId,content_data contentData,content_codec contentCodec,content_hash contentHash,created_at createdAt";
const RELATION_COLS = "id,source_note_id sourceNoteId,target_note_id targetNoteId,relation_type relationType,created_at createdAt";

function sqlInParams(ids: string[]): string {
  return ids.map(() => "?").join(",");
}

const SQLITE_IN_CHUNK_SIZE = 500;

function selectInChunks<T>(
  sqlite: SyncSqlite,
  ids: readonly string[],
  table: string,
  columns: string,
  key = "id",
): T[] {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += SQLITE_IN_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + SQLITE_IN_CHUNK_SIZE);
    rows.push(...sqlite.prepare(`SELECT ${columns} FROM ${table} WHERE ${key} IN (${sqlInParams(chunk)})`).all(...chunk) as T[]);
  }
  return rows;
}

type NoteRow = {
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
};

type AttachmentRow = { id: string; filename: string; contentHash: string };

/**
 * Resolve a list of SyncChange entries into full entity snapshots for the
 * incremental sync response. Returns the current state of each entity.
 * Deleted entities are returned as tombstones.
 *
 * Uses batch queries grouped by entity type instead of per-row queries,
 * and batch-fetches attachment references for all notes in a single query.
 */
export function resolveChangeEntities(
  sqlite: SyncSqlite,
  _attachmentRoot: string,
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
  const filtered = changes.filter(
    (c) => !(c.entityType === "setting" && isSensitiveSettingKey(c.entityId)),
  );
  if (filtered.length === 0) return [];

  const result: Array<{
    changeId: number;
    entityType: string;
    entityId: string;
    changeKind: string;
    createdAt: number;
    data: Record<string, unknown> | null;
  }> = new Array(filtered.length);

  // Group changes by entity type, preserving index for result ordering
  const byType = new Map<string, Array<{ index: number; entityId: string; changeKind: string }>>();
  for (let i = 0; i < filtered.length; i++) {
    const c = filtered[i];
    let bucket = byType.get(c.entityType);
    if (!bucket) {
      bucket = [];
      byType.set(c.entityType, bucket);
    }
    bucket.push({ index: i, entityId: c.entityId, changeKind: c.changeKind });
  }

  // Batch query notes: gather all non-deleted note IDs, fetch rows, then batch-fetch attachments
  const noteBucket = byType.get("note");
  if (noteBucket) {
    const liveIds = noteBucket.filter((e) => e.changeKind !== "deleted").map((e) => e.entityId);
    const noteMap = new Map<string, NoteRow>();
    if (liveIds.length > 0) {
      const rows = selectInChunks<NoteRow>(sqlite, liveIds, "notes", NOTE_COLS);
      for (const row of rows) noteMap.set(row.id, row);
    }

    // Batch fetch all attachment references in one query
    const allAttachmentIds = new Set<string>();
    for (const row of noteMap.values()) {
      if (row.is_protected) continue;
      for (const id of attachmentIdsFromStoredContent(row.content_data, row.content_codec as ContentCodec))
        allAttachmentIds.add(id);
    }
    const attachmentMap = new Map<string, AttachmentRow>();
    if (allAttachmentIds.size > 0) {
      const ids = [...allAttachmentIds];
      const attRows = selectInChunks<AttachmentRow>(sqlite, ids, "attachments", ATTACHMENT_COLS);
      for (const row of attRows) attachmentMap.set(row.id, row);
    }

    for (const entry of noteBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "note", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const row = noteMap.get(entry.entityId);
      let data: Record<string, unknown> | null = null;
      if (row) {
        const attachmentRefs = row.is_protected
          ? []
          : attachmentIdsFromStoredContent(row.content_data, row.content_codec as ContentCodec)
            .map((id) => attachmentMap.get(id))
            .filter((v): v is AttachmentRow => Boolean(v));
        data = {
          id: row.id, title: row.title, type: row.type,
          ...(includeNoteContent ? { contentData: Buffer.from(row.content_data).toString("base64") } : {}),
          contentCodec: row.content_codec, contentSize: row.content_size, contentHash: row.content_hash,
          ...(includeNoteContent ? { plainText: row.plain_text } : {}),
          propertiesJson: row.properties_json, isProtected: Boolean(row.is_protected),
          version: row.version, deletedAt: row.deleted_at, archivedAt: row.archived_at,
          createdAt: row.created_at, updatedAt: row.updated_at, attachmentRefs,
        };
      }
      result[entry.index] = {
        changeId: change.id, entityType: "note", entityId: entry.entityId,
        changeKind: data ? change.changeKind : "deleted", createdAt: change.createdAt, data,
      };
    }
  }

  // Batch query placements
  const placementBucket = byType.get("placement");
  if (placementBucket) {
    const liveIds = placementBucket.filter((e) => e.changeKind !== "deleted").map((e) => e.entityId);
    const placementMap = new Map<string, Record<string, unknown>>();
    if (liveIds.length > 0) {
      const rows = selectInChunks<Record<string, unknown>>(sqlite, liveIds, "placements", PLACEMENT_COLS);
      for (const row of rows) placementMap.set(row.id as string, row);
    }
    for (const entry of placementBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "placement", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const data = placementMap.get(entry.entityId) ?? null;
      result[entry.index] = {
        changeId: change.id, entityType: "placement", entityId: entry.entityId,
        changeKind: data ? change.changeKind : "deleted", createdAt: change.createdAt, data,
      };
    }
  }

  // Batch query placement-order
  const orderBucket = byType.get("placement-order");
  if (orderBucket) {
    for (const entry of orderBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "placement-order", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const version = sqlite
        .prepare("SELECT updated_at updatedAt FROM placement_order_versions WHERE parent_placement_id=?")
        .get(entry.entityId) as { updatedAt: number } | undefined;
      let data: Record<string, unknown> | null = null;
      if (version) {
        const placementIds = (
          sqlite
            .prepare(
              "SELECT id FROM placements WHERE parent_placement_id=? AND note_id NOT IN (?,?,?) ORDER BY position,id",
            )
            .all(entry.entityId, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID) as Array<{ id: string }>
        ).map((row) => row.id);
        data = { parentPlacementId: entry.entityId, placementIds, updatedAt: version.updatedAt };
      }
      result[entry.index] = {
        changeId: change.id, entityType: "placement-order", entityId: entry.entityId,
        changeKind: data ? change.changeKind : "deleted", createdAt: change.createdAt, data,
      };
    }
  }

  // Batch query attachments
  const attBucket = byType.get("attachment");
  if (attBucket) {
    const liveIds = attBucket.filter((e) => e.changeKind !== "deleted").map((e) => e.entityId);
    const attMap = new Map<string, Record<string, unknown>>();
    if (liveIds.length > 0) {
      const rows = selectInChunks<Record<string, unknown>>(sqlite, liveIds, "attachments", ATTACHMENT_FULL_COLS);
      for (const row of rows) attMap.set(row.id as string, row);
    }
    for (const entry of attBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "attachment", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const row = attMap.get(entry.entityId);
      result[entry.index] = {
        changeId: change.id, entityType: "attachment", entityId: entry.entityId,
        changeKind: row ? change.changeKind : "deleted", createdAt: change.createdAt,
        data: row ? { ...row, dataBase64: "" } : null,
      };
    }
  }

  // Batch query revisions
  const revBucket = byType.get("revision");
  if (revBucket) {
    const liveIds = revBucket.filter((e) => e.changeKind !== "deleted").map((e) => e.entityId);
    const revMap = new Map<string, Record<string, unknown>>();
    if (liveIds.length > 0) {
      const rows = selectInChunks<Record<string, unknown>>(sqlite, liveIds, "revisions", REVISION_COLS);
      for (const row of rows) {
        revMap.set(row.id as string, {
          ...row,
          contentData: Buffer.from(row.contentData as Buffer).toString("base64"),
        });
      }
    }
    for (const entry of revBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "revision", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const data = revMap.get(entry.entityId) ?? null;
      result[entry.index] = {
        changeId: change.id, entityType: "revision", entityId: entry.entityId,
        changeKind: data ? change.changeKind : "deleted", createdAt: change.createdAt, data,
      };
    }
  }

  // Batch query settings
  const settingBucket = byType.get("setting");
  if (settingBucket) {
    const liveIds = settingBucket.filter((e) => e.changeKind !== "deleted").map((e) => e.entityId);
    const settingMap = new Map<string, Record<string, unknown>>();
    if (liveIds.length > 0) {
      const rows = selectInChunks<Record<string, unknown>>(sqlite, liveIds, "settings", "key,value,updated_at updatedAt", "key");
      for (const row of rows) settingMap.set(row.key as string, row);
    }
    for (const entry of settingBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "setting", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const data = settingMap.get(entry.entityId) ?? null;
      result[entry.index] = {
        changeId: change.id, entityType: "setting", entityId: entry.entityId,
        changeKind: data ? change.changeKind : "deleted", createdAt: change.createdAt, data,
      };
    }
  }

  // Batch query relations
  const relBucket = byType.get("relation");
  if (relBucket) {
    const liveIds = relBucket.filter((e) => e.changeKind !== "deleted").map((e) => e.entityId);
    const relMap = new Map<string, Record<string, unknown>>();
    if (liveIds.length > 0) {
      const rows = selectInChunks<Record<string, unknown>>(sqlite, liveIds, "relations", RELATION_COLS);
      for (const row of rows) relMap.set(row.id as string, row);
    }
    for (const entry of relBucket) {
      const change = filtered[entry.index];
      if (entry.changeKind === "deleted") {
        result[entry.index] = {
          changeId: change.id, entityType: "relation", entityId: entry.entityId,
          changeKind: "deleted", createdAt: change.createdAt, data: null,
        };
        continue;
      }
      const data = relMap.get(entry.entityId) ?? null;
      result[entry.index] = {
        changeId: change.id, entityType: "relation", entityId: entry.entityId,
        changeKind: data ? change.changeKind : "deleted", createdAt: change.createdAt, data,
      };
    }
  }

  return result;
}

export function attachmentIdsFromStoredContent(data: Buffer, codec: ContentCodec): string[] {
  return [...attachmentIdsFromSerializedDocument(decodeStoredContent(data, codec))];
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

type SnapshotEntity = ReturnType<typeof resolveChangeEntities>[number];
type SnapshotSession = { changes: SnapshotEntity[]; maxChangeId: number; accessedAt: number };

/**
 * Session-scoped snapshot cache. A snapshot session is anchored to a single
 * fullSnapshotChanges() result and is valid only for the duration of one
 * complete cursor traversal (cursor=0 → hasMore=false). If the client
 * restarts from cursor=0, a fresh session is created so it never sees stale
 * data from a concurrent write during the previous session.
 */
class SnapshotCache {
  private sessions = new Map<string, SnapshotSession>();
  private static SESSION_TTL_MS = 5 * 60 * 1000;
  private static MAX_SESSIONS = 2;

  /** Capture the resolved entities, including note bodies, at session start.
   * Keeping only entity IDs is not sufficient: a later page could otherwise
   * observe a newer edit or a deletion made after the first page. */
  getOrCreate(sessionId: string, sqlite: SyncSqlite, attachmentRoot: string): SnapshotSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.accessedAt = Date.now();
      return existing;
    }
    this.evictStale();
    if (this.sessions.size >= SnapshotCache.MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt)[0]?.[0];
      if (oldest) this.sessions.delete(oldest);
    }
    const changes = resolveChangeEntities(sqlite, attachmentRoot, fullSnapshotChanges(sqlite), true);
    const maxChangeId = (sqlite.prepare("SELECT COALESCE(MAX(id),0) id FROM sync_change_log").get() as { id: number }).id;
    const session = { changes, maxChangeId, accessedAt: Date.now() };
    this.sessions.set(sessionId, session);
    return session;
  }

  getNoteContents(sessionId: string, ids: readonly string[], hashes: readonly string[]) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.accessedAt = Date.now();
    const byId = new Map(session.changes.filter((change) => change.entityType === "note" && change.data)
      .map((change) => [change.entityId, change.data!]));
    const contents: Record<string, { contentData: string; contentCodec: string; contentSize: number; contentHash: string; plainText: string } | null> = {};
    for (let index = 0; index < ids.length; index += 1) {
      const data = byId.get(ids[index]);
      if (!data || data.contentHash !== hashes[index] || typeof data.contentData !== "string") {
        contents[ids[index]] = null;
        continue;
      }
      contents[ids[index]] = {
        contentData: data.contentData as string,
        contentCodec: data.contentCodec as string,
        contentSize: data.contentSize as number,
        contentHash: data.contentHash as string,
        plainText: data.plainText as string,
      };
    }
    return contents;
  }

  /** Release a session so its memory can be reclaimed. Called when the
   * snapshot traversal is complete (hasMore=false). */
  release(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  private evictStale() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.accessedAt > SnapshotCache.SESSION_TTL_MS) this.sessions.delete(id);
    }
  }
}

export const snapshotCache = new SnapshotCache();

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

/**
 * A sync sender can legitimately retry an already-delivered entity snapshot
 * (for example after an interrupted cursor advance). Equal timestamps are
 * normally rejected by last-write-wins, but an identical snapshot is not a
 * conflict: it is an idempotent replay and must not reach the conflict UI.
 */
function noteMatchesSyncSnapshot(
  sqlite: SyncSqlite,
  data: Record<string, unknown>,
): boolean {
  if (typeof data.id !== "string" || typeof data.contentData !== "string") return false;
  const local = sqlite
    .prepare(
      "SELECT id,title,type,content_data contentData,content_codec contentCodec,content_size contentSize,content_hash contentHash,plain_text plainText,is_protected isProtected,properties_json propertiesJson,version,deleted_at deletedAt,archived_at archivedAt,created_at createdAt,updated_at updatedAt FROM notes WHERE id=?",
    )
    .get(data.id) as
    | {
        id: string;
        title: string;
        type: string;
        contentData: Buffer;
        contentCodec: string;
        contentSize: number;
        contentHash: string;
        plainText: string;
        isProtected: number;
        propertiesJson: string;
        version: number;
        deletedAt: number | null;
        archivedAt: number | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  return Boolean(
    local &&
      local.title === data.title &&
      local.type === data.type &&
      local.contentData.equals(Buffer.from(data.contentData, "base64")) &&
      local.contentCodec === data.contentCodec &&
      local.contentSize === data.contentSize &&
      local.contentHash === data.contentHash &&
      local.plainText === data.plainText &&
      Boolean(local.isProtected) === data.isProtected &&
      local.propertiesJson === data.propertiesJson &&
      local.version === data.version &&
      local.deletedAt === data.deletedAt &&
      local.archivedAt === data.archivedAt &&
      local.createdAt === data.createdAt &&
      local.updatedAt === data.updatedAt,
  );
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
          // Equal timestamp + identical fields is an idempotent retry, not a
          // competing edit.  In particular, this prevents a create followed
          // by an immediate save from surfacing a false sync conflict when a
          // peer receives the latest snapshot twice.
          if (noteMatchesSyncSnapshot(sqlite, d)) continue;
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
        // The anti-resurrection guard mirrors the `relation` and `setting`
        // branches: a note that was permanently deleted here leaves a tombstone,
        // and a peer carrying an older copy must not be able to re-create it.
        // Without this a device that went silent for months would re-seed every
        // note the user purged while it was away. A genuinely newer edit
        // (updatedAt past the deletion) still wins, matching last-write-wins.
        const result = sqlite
          .prepare(
            "INSERT INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,is_protected,properties_json,version,deleted_at,archived_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type='note' AND entity_id=? AND deleted_at>=?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,type=excluded.type,content_data=excluded.content_data,content_codec=excluded.content_codec,content_size=excluded.content_size,content_hash=excluded.content_hash,plain_text=excluded.plain_text,is_protected=excluded.is_protected,properties_json=excluded.properties_json,version=excluded.version,deleted_at=excluded.deleted_at,archived_at=excluded.archived_at,updated_at=excluded.updated_at WHERE excluded.updated_at > notes.updated_at",
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
            d.id,
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
            "INSERT INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM notes WHERE id=?) AND NOT EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type='placement' AND entity_id=? AND deleted_at>=?) ON CONFLICT(id) DO UPDATE SET note_id=excluded.note_id,parent_placement_id=excluded.parent_placement_id,position=excluded.position,updated_at=excluded.updated_at WHERE excluded.updated_at > placements.updated_at",
          )
          .run(
            d.id,
            d.noteId,
            d.parentPlacementId ?? null,
            d.position,
            d.createdAt,
            d.updatedAt,
            d.noteId,
            d.id,
            d.updatedAt,
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
          // The recorded boundary is the change-log position that will carry
          // this deletion onward, so maintenance can later tell whether every
          // peer has seen it. Without it the tombstone would be unprunable.
          sqlite
            .prepare(
              `INSERT INTO sync_tombstones (entity_type,entity_id,deleted_at,change_log_id) VALUES ('setting',?,?,${NEXT_CHANGE_LOG_ID_SQL}) ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at,change_log_id=excluded.change_log_id WHERE excluded.deleted_at > sync_tombstones.deleted_at`,
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
