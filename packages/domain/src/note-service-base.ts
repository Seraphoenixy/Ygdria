import { createHash, randomUUID } from "node:crypto";
import {
  decodeStoredContent,
  encodeCiphertextContent,
  encodeDocumentContent,
  recordChange,
  recordChanges,
  type ContentCodec,
  type createDatabase,
} from "@ygdria/database";
import { markdownToTiptap, plainText, tiptapToMarkdown } from "@ygdria/editor/markdown";
import {
  emptyDocument,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_ROOT_PLACEMENT_ID,
  SYSTEM_TRASH_NOTE_ID,
  SYSTEM_TRASH_PLACEMENT_ID,
  CALENDAR_NOTE_ID,
  CALENDAR_PLACEMENT_ID,
  PLACEMENT_DELETION_MAX_RECORDS,
  PLACEMENT_DELETION_RETENTION_MS,
  type NoteContent,
  type SearchResult,
} from "@ygdria/shared";
import {
  readCodeLanguage,
  readTags,
  codeProperties,
  tagsProperties,
} from "./properties-utils.js";
type Store = ReturnType<typeof createDatabase>;
// `updated_at` is used as a last-writer-wins version by sync. Date.now() alone
// can return the same value for consecutive mutations, causing a causally later
// delete/restore to be discarded by a peer's strict version comparison.
let lastTimestamp = 0;

export const now = () => {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return lastTimestamp;
};
export const id = () => randomUUID();
export type PlacementSnapshot = {
  placements: Array<{
    id: string;
    noteId: string;
    parentPlacementId: string | null;
    position: number;
    createdAt: number;
    updatedAt: number;
  }>;
  autoTrashedNoteIds: string[];
};
// Row shapes returned by better-sqlite3 queries. These mirror the column
// aliases used in the SQL strings and replace `any` escapes at query sites.
type NoteRow = {
  id: string;
  title: string;
  type: string;
  content_data: Buffer;
  content_codec: string;
  content_size: number;
  content_hash: string;
  plain_text: string;
  properties_json: string;
  version: number;
  deleted_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  is_protected: 0 | 1;
};
export type TreeRow = {
  placementId: string;
  noteId: string;
  parentPlacementId: string | null;
  position: number;
  title: string;
  contentData: Buffer;
  contentCodec: string;
  isProtected: 0 | 1;
  type: string;
  isTrashed: 0 | 1;
  isArchived: 0 | 1;
  isSystem: 0 | 1;
  isCalendar: 0 | 1;
  isTrash: 0 | 1;
};
export type PositionRow = { p: number };
type ArchivedNoteRow = {
  id: string;
  title: string;
  archivedAt: number;
  updatedAt: number;
};
export type RevisionRow = {
  id: string;
  contentHash: string;
  createdAt: number;
};
export type SearchRow = {
  noteId: string;
  title: string;
  snippet: string;
  updatedAt: number;
  isArchived: 0 | 1;
};
export type IdRow = { id: string };
type NoteIdRow = { note_id: string };
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
  }
}
export class ConflictError extends Error {
  constructor(message = "Note changed elsewhere; refresh before saving.") {
    super(message);
  }
}
export class NoteServiceBase {
  constructor(protected store: Store) {}
  create(input: { title: string; parentPlacementId?: string | null; type?: "text" | "code"; content?: NoteContent; code?: string; tags?: string[] }) {
    const t = now(),
      noteId = id(),
      placementId = id(),
      noteType = input.type ?? "text",
      document = input.content ?? emptyDocument,
      code = input.code ?? "",
      parentPlacementId = input.parentPlacementId ?? SYSTEM_ROOT_PLACEMENT_ID;
    this.assertParent(parentPlacementId);
    this.assertCanUseAsNormalParent(parentPlacementId);
    const rawContent = noteType === "code" ? code : JSON.stringify(document);
    const stored = encodeDocumentContent(rawContent);
    const propsJson = noteType === "code"
      ? codeProperties("plaintext", tagsProperties(input.tags))
      : tagsProperties(input.tags);
    const p = this.store.sqlite
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 p FROM placements WHERE parent_placement_id IS ?",
      )
      .get(parentPlacementId) as { p: number };
    this.store.sqlite.transaction(() => {
      this.store.sqlite
        .prepare(
          "INSERT INTO notes (id,title,type,content_data,content_codec,content_size,content_hash,plain_text,properties_json,version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          noteId,
          input.title,
          noteType,
          stored.data,
          stored.codec,
          stored.size,
          rawContentHash(rawContent),
          noteType === "code" ? code : plainText(document),
          propsJson,
          1,
          null,
          t,
          t,
        );
      this.store.sqlite
        .prepare("INSERT INTO placements VALUES (?,?,?,?,?,?)")
        .run(placementId, noteId, parentPlacementId, p.p, t, t);
      this.index(noteId, input.title);
      recordChange(this.store.sqlite, "note", noteId, "created");
      recordChange(this.store.sqlite, "placement", placementId, "created");
    })();
    return this.get(noteId)!;
  }
  createToday(input: { title: string; content?: NoteContent }) {
    return this.create({ ...input, parentPlacementId: this.ensureCalendarDay() });
  }
  protected ensureCalendarDay(): string {
    throw new Error("Calendar support is not available on the base service");
  }
  /** Return today's calendar-day note, creating only the calendar hierarchy. */
  ensureTodayNote() {
    const dayPlacementId = this.ensureCalendarDay();
    const row = this.store.sqlite
      .prepare("SELECT note_id noteId FROM placements WHERE id=?")
      .get(dayPlacementId) as { noteId?: string } | undefined;
    if (!row?.noteId) throw new NotFoundError("Today's calendar day was not created");
    return this.get(row.noteId)!;
  }
  get(noteId: string) {
    const row = this.store.sqlite
      .prepare("SELECT * FROM notes WHERE id=? AND deleted_at IS NULL")
      .get(noteId) as NoteRow | undefined;
    if (!row) return null;
    if (row.is_protected) {
      return {
        id: row.id,
        title: "",
        type: row.type,
        content: null,
        contentCiphertext: decodeStoredContent(row.content_data, row.content_codec as ContentCodec),
        version: row.version,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        archivedAt: row.archived_at ?? null,
        isProtected: true as const,
      };
    }
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      codeLanguage: row.type === "code" ? readCodeLanguage(row.properties_json) : undefined,
      tags: row.is_protected ? [] : readTags(row.properties_json),
      content: row.type === "code"
        ? decodeStoredContent(row.content_data, row.content_codec as ContentCodec)
        : JSON.parse(decodeStoredContent(row.content_data, row.content_codec as ContentCodec)) as NoteContent,
      version: row.version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      archivedAt: row.archived_at ?? null,
      isProtected: false as const,
    };
  }
  isArchived(noteId: string) {
    const row = this.store.sqlite
      .prepare("SELECT archived_at archivedAt FROM notes WHERE id=?")
      .get(noteId) as { archivedAt: number | null } | undefined;
    if (!row) throw new NotFoundError();
    return row.archivedAt !== null;
  }
  archiveNote(noteId: string, archived: boolean) {
    this.assertNotSystemNote(noteId);
    const row = this.store.sqlite
      .prepare("SELECT deleted_at deletedAt,archived_at archivedAt,is_protected isProtected FROM notes WHERE id=?")
      .get(noteId) as { deletedAt: number | null; archivedAt: number | null; isProtected: number } | undefined;
    if (!row) throw new NotFoundError();
    if (row.deletedAt !== null)
      throw new ConflictError("Deleted notes must be restored before changing archive status");
    if (Boolean(row.isProtected)) throw new ConflictError("Protected notes cannot be archived");
    if ((row.archivedAt !== null) === archived) return this.get(noteId)!;
    const timestamp = now();
    this.store.sqlite
      .prepare("UPDATE notes SET archived_at=?,updated_at=?,version=version+1 WHERE id=?")
      .run(archived ? timestamp : null, timestamp, noteId);
    recordChange(this.store.sqlite, "note", noteId, "updated");
    return this.get(noteId)!;
  }
  /**
   * Archives (or restores) a note together with every note in its subtree. The
   * root is validated and archived by `archiveNote` first, so a system, deleted,
   * or protected root still throws. Descendants that are protected (cannot be
   * archived) or already in the target state are skipped. Returns the number of
   * notes whose archive state actually changed.
   */
  archiveSubtree(noteId: string, archived: boolean) {
    this.archiveNote(noteId, archived);
    const ids = this.placementSubtreeNoteIdsForNote(noteId);
    let changed = 1;
    this.store.sqlite.transaction(() => {
      for (const id of ids) {
        if (id === noteId) continue;
        if (id === SYSTEM_ROOT_NOTE_ID || id === SYSTEM_TRASH_NOTE_ID || id === CALENDAR_NOTE_ID)
          continue;
        const row = this.store.sqlite
          .prepare("SELECT deleted_at deletedAt,archived_at archivedAt,is_protected isProtected FROM notes WHERE id=?")
          .get(id) as { deletedAt: number | null; archivedAt: number | null; isProtected: number } | undefined;
        if (!row || row.deletedAt !== null) continue;
        if (Boolean(row.isProtected)) continue;
        if ((row.archivedAt !== null) === archived) continue;
        const timestamp = now();
        this.store.sqlite
          .prepare("UPDATE notes SET archived_at=?,updated_at=?,version=version+1 WHERE id=?")
          .run(archived ? timestamp : null, timestamp, id);
        recordChange(this.store.sqlite, "note", id, "updated");
        changed++;
      }
    })();
    return changed;
  }
  setProtected(noteId: string, input: { protected: true; contentCiphertext: string } | { protected: false; title: string; content: NoteContent | string; propertiesJson?: string }) {
    this.assertNotSystemNote(noteId);
    const row = this.store.sqlite.prepare("SELECT * FROM notes WHERE id=? AND deleted_at IS NULL").get(noteId) as NoteRow | undefined;
    if (!row) throw new NotFoundError();
    if (Boolean(row.is_protected) === input.protected) return this.get(noteId)!;
    if (input.protected && row.type !== "code") {
      const document = JSON.parse(decodeStoredContent(row.content_data, row.content_codec as ContentCodec)) as NoteContent;
      if (attachmentIds(document).size > 0) throw new ConflictError("Remove attachments before protecting this note");
    }
    // Enable secure deletion before removing the old FTS and revision rows.
    this.store.sqlite.pragma("secure_delete=ON");
    this.store.sqlite.transaction(() => {
      if (input.protected) {
        const { contentCiphertext } = input as { protected: true; contentCiphertext: string };
        const stored = encodeCiphertextContent(contentCiphertext);
        this.deleteIndex(noteId);
        this.store.sqlite.prepare("UPDATE notes SET title='',content_data=?,content_codec=?,content_size=?,content_hash=?,plain_text='',properties_json='{}',is_protected=1,version=version+1,updated_at=? WHERE id=?").run(stored.data, stored.codec, stored.size, createHash("sha256").update(contentCiphertext).digest("hex"), now(), noteId);
        const revisionIds = this.store.sqlite.prepare("SELECT id FROM revisions WHERE note_id=?").all(noteId) as Array<{ id: string }>;
        this.store.sqlite.prepare("DELETE FROM revisions WHERE note_id=?").run(noteId);
        recordChange(this.store.sqlite, "note", noteId, "updated");
        recordChanges(this.store.sqlite, revisionIds.map(({ id }) => ({ entityType: "revision", entityId: id, changeKind: "deleted" as const })));
      } else {
        const { title, content, propertiesJson } = input as { protected: false; title: string; content: NoteContent | string; propertiesJson?: string };
        const rawContent = row.type === "code" ? String(content) : JSON.stringify(content);
        const stored = encodeDocumentContent(rawContent);
        const indexedText = row.type === "code" ? rawContent : plainText(content as NoteContent);
        this.store.sqlite.prepare("UPDATE notes SET title=?,content_data=?,content_codec=?,content_size=?,content_hash=?,plain_text=?,properties_json=?,is_protected=0,version=version+1,updated_at=? WHERE id=?").run(title, stored.data, stored.codec, stored.size, rawContentHash(rawContent), indexedText, propertiesJson ?? "{}", now(), noteId);
        this.index(noteId, title);
        recordChange(this.store.sqlite, "note", noteId, "updated");
      }
    })();
    if (input.protected) this.purgePlaintextResidue();
    return this.get(noteId)!;
  }
  /** Rewrites the database after a note becomes protected to reclaim deleted plaintext pages. */
  purgePlaintextResidue() {
    this.store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    this.store.sqlite.exec("VACUUM");
    this.store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  }
  listArchivedNotes() {
    return (
      this.store.sqlite
        .prepare(
          "SELECT id,title,archived_at archivedAt,updated_at updatedAt FROM notes WHERE deleted_at IS NULL AND archived_at IS NOT NULL AND is_protected=0 ORDER BY archived_at DESC",
        )
        .all() as ArchivedNoteRow[]
    ).map((note) => ({ ...note, updatedAt: new Date(note.updatedAt).toISOString() }));
  }
  update(
    noteId: string,
    input: { title?: string; type?: "text" | "code"; content?: NoteContent; code?: string; codeLanguage?: string; tags?: string[]; contentCiphertext?: string; revisionIntervalMs?: number; createRevision?: boolean; expectedVersion: number },
  ) {
    this.assertNotSystemNote(noteId);
    const old = this.get(noteId);
    if (!old) throw new NotFoundError();
    if (input.expectedVersion !== old.version) throw new ConflictError();
    const t = now();
    if (old.isProtected) {
      // Protected notes: only accept contentCiphertext updates
      if (!input.contentCiphertext) return old;
      const updated = this.store.sqlite
        .prepare(
          "UPDATE notes SET content_data=?, content_codec=?, content_size=?, content_hash=?, version=version+1, updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL",
        )
        .run(
          encodeCiphertextContent(input.contentCiphertext).data,
          "ciphertext-v1",
          Buffer.byteLength(input.contentCiphertext),
          createHash("sha256").update(input.contentCiphertext).digest("hex"),
          t,
          noteId,
          input.expectedVersion,
        );
      if (!updated.changes) throw new ConflictError();
      recordChange(this.store.sqlite, "note", noteId, "updated");
      return this.get(noteId)!;
    }
    if (input.type && input.type !== old.type) {
      const nextType = input.type;
      const title = input.title ?? old.title;
      const code = old.type === "code"
        ? (typeof old.content === "string" ? old.content : "")
        : plainText(old.content as NoteContent);
      const document: NoteContent = old.type === "code"
        ? { type: "doc", content: [{ type: "codeBlock", attrs: { language: old.codeLanguage ?? "plaintext" }, content: code ? [{ type: "text", text: code }] : [] }] }
        : (old.content as NoteContent);
      this.store.sqlite.transaction(() => {
        this.deleteIndex(noteId);
        const previous = old.type === "code" ? code : JSON.stringify(old.content);
        const previousStored = encodeDocumentContent(previous);
        const revisionId = id();
        this.store.sqlite.prepare("INSERT INTO revisions (id,note_id,content_data,content_codec,content_hash,created_at) VALUES (?,?,?,?,?,?)")
          .run(revisionId, noteId, previousStored.data, previousStored.codec, old.type === "code" ? rawContentHash(previous) : contentHash(old.content as NoteContent), t);
        recordChange(this.store.sqlite, "revision", revisionId, "created");
        const rawContent = nextType === "code" ? code : JSON.stringify(document);
        const stored = encodeDocumentContent(rawContent);
        const oldPropsJson = (this.store.sqlite.prepare("SELECT properties_json FROM notes WHERE id=?").get(noteId) as { properties_json: string } | undefined)?.properties_json ?? "{}";
        const nextPropsJson = nextType === "code"
          ? codeProperties(input.codeLanguage ?? old.codeLanguage ?? "plaintext", tagsProperties(input.tags, oldPropsJson))
          : tagsProperties(input.tags, oldPropsJson);
        const updated = this.store.sqlite.prepare("UPDATE notes SET title=?,type=?,content_data=?,content_codec=?,content_size=?,content_hash=?,plain_text=?,properties_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL")
          .run(title, nextType, stored.data, stored.codec, stored.size, nextType === "code" ? rawContentHash(rawContent) : contentHash(document), nextType === "code" ? code : plainText(document), nextPropsJson, t, noteId, input.expectedVersion);
        if (!updated.changes) throw new ConflictError();
        this.index(noteId, title);
        recordChange(this.store.sqlite, "note", noteId, "updated");
      })();
      return this.get(noteId)!;
    }
    // Non-protected notes: plaintext update with revisions and FTS indexing
    // The code-note branch above has returned, so both values are TipTap documents.
    // `get()` cannot express that relationship between `type` and `content` yet.
    const document = (input.content ?? old.content) as NoteContent,
      oldDocument = old.content as NoteContent,
      title = input.title ?? old.title;
    if (old.type === "code") {
      const code = input.code ?? (typeof old.content === "string" ? old.content : "");
      const contentChanged = input.code !== undefined && rawContentHash(code) !== rawContentHash(typeof old.content === "string" ? old.content : "");
      const titleChanged = title !== old.title;
      const language = input.codeLanguage ?? old.codeLanguage ?? "plaintext";
      const languageChanged = language !== (old.codeLanguage ?? "plaintext");
      const tagsChanged = input.tags !== undefined;
      if (!contentChanged && !titleChanged && !languageChanged && !tagsChanged) return old;
      const oldRow = this.store.sqlite.prepare("SELECT properties_json FROM notes WHERE id=?").get(noteId) as { properties_json: string } | undefined;
      const oldPropsJson = oldRow?.properties_json ?? "{}";
      this.store.sqlite.transaction(() => {
        this.deleteIndex(noteId);
        const newPropsJson = codeProperties(language, tagsProperties(input.tags, oldPropsJson));
        if (contentChanged) {
          const previous = encodeDocumentContent(typeof old.content === "string" ? old.content : "");
          if (input.createRevision !== false && this.shouldCreateRevision(noteId, t, input.revisionIntervalMs)) {
            const revisionId = id();
            this.store.sqlite.prepare("INSERT INTO revisions (id,note_id,content_data,content_codec,content_hash,created_at) VALUES (?,?,?,?,?,?)")
              .run(revisionId, noteId, previous.data, previous.codec, rawContentHash(typeof old.content === "string" ? old.content : ""), t);
            recordChange(this.store.sqlite, "revision", revisionId, "created");
          }
          const stored = encodeDocumentContent(code);
          const updated = this.store.sqlite.prepare("UPDATE notes SET title=?,content_data=?,content_codec=?,content_size=?,content_hash=?,plain_text=?,properties_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL")
            .run(title, stored.data, stored.codec, stored.size, rawContentHash(code), code, newPropsJson, t, noteId, input.expectedVersion);
          if (!updated.changes) throw new ConflictError();
        } else {
          const updated = this.store.sqlite.prepare("UPDATE notes SET title=?,properties_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL")
            .run(title, newPropsJson, t, noteId, input.expectedVersion);
          if (!updated.changes) throw new ConflictError();
        }
        this.index(noteId, title);
        recordChange(this.store.sqlite, "note", noteId, "updated");
      })();
      return this.get(noteId)!;
    }
    const contentChanged =
      input.content !== undefined && contentHash(document) !== contentHash(oldDocument);
    const titleChanged = title !== old.title;
    const tagsChanged = input.tags !== undefined;
    if (!contentChanged && !titleChanged && !tagsChanged) return old;
    this.store.sqlite.transaction(() => {
      this.deleteIndex(noteId);
      if (contentChanged) {
        const previous = encodeDocumentContent(JSON.stringify(old.content));
        if (input.createRevision !== false && this.shouldCreateRevision(noteId, t, input.revisionIntervalMs)) {
          const revisionId = id();
          this.store.sqlite
            .prepare("INSERT INTO revisions (id,note_id,content_data,content_codec,content_hash,created_at) VALUES (?,?,?,?,?,?)")
            .run(revisionId, noteId, previous.data, previous.codec, contentHash(oldDocument), t);
          recordChange(this.store.sqlite, "revision", revisionId, "created");
        }
        const stored = encodeDocumentContent(JSON.stringify(document));
        const oldRow = this.store.sqlite.prepare("SELECT properties_json FROM notes WHERE id=?").get(noteId) as { properties_json: string } | undefined;
        const oldPropsJson = oldRow?.properties_json ?? "{}";
        const newPropsJson = tagsProperties(input.tags, oldPropsJson);
        const updated = this.store.sqlite
          .prepare(
            "UPDATE notes SET title=?, content_data=?, content_codec=?, content_size=?, content_hash=?, plain_text=?, properties_json=?, version=version+1, updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL",
          )
          .run(
            title,
            stored.data,
            stored.codec,
            stored.size,
            contentHash(document),
            plainText(document),
            newPropsJson,
            t,
            noteId,
            input.expectedVersion,
          );
        if (!updated.changes) throw new ConflictError();
      } else {
        const oldRow = this.store.sqlite.prepare("SELECT properties_json FROM notes WHERE id=?").get(noteId) as { properties_json: string } | undefined;
        const oldPropsJson = oldRow?.properties_json ?? "{}";
        const newPropsJson = tagsProperties(input.tags, oldPropsJson);
        const updated = this.store.sqlite
          .prepare(
            "UPDATE notes SET title=?, properties_json=?, version=version+1, updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL",
          )
          .run(title, newPropsJson, t, noteId, input.expectedVersion);
        if (!updated.changes) throw new ConflictError();
      }
      if (contentChanged || titleChanged) this.index(noteId, title);
      if (contentChanged) this.releaseRemovedAttachments(oldDocument, document, t);
      recordChange(this.store.sqlite, "note", noteId, "updated");
    })();
    return this.get(noteId)!;
  }
  protected index(noteId: string, title: string) {
    this.store.sqlite
      .prepare("INSERT INTO notes_fts(rowid,title,plain_text,properties_json) SELECT rowid,title,plain_text,properties_json FROM notes WHERE id=?")
      .run(noteId);
  }
  private releaseRemovedAttachments(previous: NoteContent, next: NoteContent, timestamp: number) {
    const removed = [...attachmentIds(previous)].filter((attachmentId) => !attachmentIds(next).has(attachmentId));
    if (removed.length === 0) return;
    const referenced = new Set<string>();
    const rows = this.store.sqlite.prepare("SELECT content_data contentData,content_codec contentCodec FROM notes WHERE is_protected=0 AND type<>'code'").all() as Array<{ contentData: Buffer; contentCodec: ContentCodec }>;
    for (const row of rows) {
      try {
        for (const id of attachmentIds(JSON.parse(decodeStoredContent(row.contentData, row.contentCodec)) as NoteContent)) referenced.add(id);
      } catch { return; /* invalid documents are handled by doctor; never infer deletion from them */ }
    }
    for (const attachmentId of removed) {
      if (referenced.has(attachmentId)) continue;
      const attachment = this.store.sqlite.prepare("SELECT storage_key storageKey FROM attachments WHERE id=?").get(attachmentId) as { storageKey: string } | undefined;
      if (!attachment) continue;
      this.store.sqlite.prepare("DELETE FROM attachments WHERE id=?").run(attachmentId);
      this.store.sqlite.prepare("INSERT OR IGNORE INTO storage_cleanup_jobs(id,storage_key,reason,attempts,created_at) VALUES (?,?,?,?,?)")
        .run(id(), attachment.storageKey, "content-reference-removed", 0, timestamp);
      recordChange(this.store.sqlite, "attachment", attachmentId, "deleted");
    }
  }
  protected assertNotSystemNote(noteId: string) {
    if (noteId === SYSTEM_ROOT_NOTE_ID || noteId === SYSTEM_TRASH_NOTE_ID)
      throw new ConflictError("System notes are protected");
  }
  protected assertNotSystemPlacement(placementId: string) {
    if (placementId === SYSTEM_ROOT_PLACEMENT_ID || placementId === SYSTEM_TRASH_PLACEMENT_ID || placementId === CALENDAR_PLACEMENT_ID)
      throw new ConflictError("System placements are protected");
  }
  protected assertCanUseAsNormalParent(placementId: string) {
    if (placementId === SYSTEM_TRASH_PLACEMENT_ID)
      throw new ConflictError("Move a note to the trash through the delete command");
  }
  protected assertParent(placementId: string) {
    const parent = this.store.sqlite
      .prepare(
        "SELECT 1 FROM placements p JOIN notes n ON n.id=p.note_id WHERE p.id=? AND n.deleted_at IS NULL",
      )
      .get(placementId);
    if (!parent) throw new NotFoundError("Parent placement not found");
  }
  protected isDescendant(placementId: string, ancestorId: string) {
    return Boolean(
      this.store.sqlite
        .prepare(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id FROM placements WHERE parent_placement_id=?
             UNION
             SELECT p.id FROM placements p JOIN descendants d ON p.parent_placement_id=d.id
           ) SELECT 1 FROM descendants WHERE id=? LIMIT 1`,
        )
        .get(ancestorId, placementId),
    );
  }
  protected placementSubtree(placementId: string): PlacementSnapshot["placements"] {
    return this.store.sqlite
      .prepare(
        `WITH RECURSIVE subtree(id,note_id,parent_placement_id,position,created_at,updated_at,depth) AS (
           SELECT id,note_id,parent_placement_id,position,created_at,updated_at,0 FROM placements WHERE id=?
           UNION ALL
           SELECT p.id,p.note_id,p.parent_placement_id,p.position,p.created_at,p.updated_at,s.depth+1 FROM placements p JOIN subtree s ON p.parent_placement_id=s.id
         ) SELECT id,note_id noteId,parent_placement_id parentPlacementId,position,created_at createdAt,updated_at updatedAt FROM subtree ORDER BY depth`,
      )
      .all(placementId)
      .map((row) => row as PlacementSnapshot["placements"][number]);
  }
  protected placementSubtreeNoteIdsForNote(noteId: string) {
    return (
      this.store.sqlite
        .prepare(
          `WITH RECURSIVE subtree(id,note_id) AS (
           SELECT id,note_id FROM placements WHERE note_id=?
           UNION ALL
           SELECT p.id,p.note_id FROM placements p JOIN subtree s ON p.parent_placement_id=s.id
         ) SELECT DISTINCT note_id FROM subtree`,
        )
        .all(noteId) as NoteIdRow[]
    ).map((row) => row.note_id as string);
  }
  protected placementSubtreesForNote(noteId: string) {
    const roots = this.store.sqlite
      .prepare("SELECT id FROM placements WHERE note_id=? ORDER BY created_at,id")
      .all(noteId) as Array<{ id: string }>;
    const seen = new Set<string>();
    const placements: PlacementSnapshot["placements"] = [];
    for (const root of roots) {
      for (const placement of this.placementSubtree(root.id)) {
        if (seen.has(placement.id)) continue;
        seen.add(placement.id);
        placements.push(placement);
      }
    }
    return placements;
  }
  protected moveOrphanNotesToTrash(affectedNoteIds: string[], forceNoteId?: string) {
    const t = now();
    const autoTrashedNoteIds: string[] = [];
    for (const noteId of affectedNoteIds) {
      if (noteId === SYSTEM_ROOT_NOTE_ID || noteId === SYSTEM_TRASH_NOTE_ID) continue;
      const hasPlacement = Boolean(
        this.store.sqlite.prepare("SELECT 1 FROM placements WHERE note_id=?").get(noteId),
      );
      if (noteId !== forceNoteId && hasPlacement) continue;
      this.deleteIndex(noteId);
      const updated = this.store.sqlite
        .prepare("UPDATE notes SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL")
        .run(t, t, noteId);
      if (!updated.changes) continue;
      autoTrashedNoteIds.push(noteId);
      const position = this.store.sqlite
        .prepare(
          "SELECT COALESCE(MAX(position),-1)+1 position FROM placements WHERE parent_placement_id=?",
        )
        .get(SYSTEM_TRASH_PLACEMENT_ID) as { position: number };
      this.store.sqlite
        .prepare(
          "INSERT OR IGNORE INTO placements (id,note_id,parent_placement_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(id(), noteId, SYSTEM_TRASH_PLACEMENT_ID, position.position, t, t);
    }
    return autoTrashedNoteIds;
  }
  protected normalParentExists(placementId: string) {
    return Boolean(
      this.store.sqlite
        .prepare(
          "SELECT 1 FROM placements p JOIN notes n ON n.id=p.note_id WHERE p.id=? AND n.deleted_at IS NULL",
        )
        .get(placementId),
    );
  }
  protected rebuildSearchIndex(noteId: string) {
    const note = this.store.sqlite
      .prepare("SELECT title,content_data contentData,content_codec contentCodec,is_protected isProtected FROM notes WHERE id=? AND deleted_at IS NULL")
      .get(noteId) as { title: string; contentData: Buffer; contentCodec: ContentCodec; isProtected: number } | undefined;
    if (!note) return;
    if (note.isProtected) return;
    this.index(noteId, note.title);
  }
  private shouldCreateRevision(noteId: string, timestamp: number, intervalMs?: number) {
    if (!intervalMs) return true;
    const latest = this.store.sqlite
      .prepare("SELECT created_at createdAt FROM revisions WHERE note_id=? ORDER BY created_at DESC LIMIT 1")
      .get(noteId) as { createdAt: number } | undefined;
    return !latest || timestamp - latest.createdAt >= intervalMs;
  }
  protected deleteIndex(noteId: string) {
    this.store.sqlite
      .prepare(
        "INSERT INTO notes_fts(notes_fts,rowid,title,plain_text,properties_json) SELECT 'delete',rowid,title,plain_text,properties_json FROM notes WHERE id=? AND is_protected=0 AND deleted_at IS NULL",
      )
      .run(noteId);
  }
}
function contentHash(content: NoteContent) {
  return createHash("sha256").update(stableJson(content)).digest("hex");
}
function attachmentIds(content: NoteContent): Set<string> {
  const ids = new Set<string>();
  for (const match of JSON.stringify(content).matchAll(/\/api\/v1\/attachments\/([0-9a-f-]{36})(?:["'?/#]|$)/gi)) ids.add(match[1]);
  return ids;
}
function rawContentHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>\"]/g,
    (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[x]!,
  );
}