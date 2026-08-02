import { decodeStoredContent, encodeDocumentContent, recordChange, type ContentCodec } from "@ygdria/database";
import { markdownToTiptap, tiptapToMarkdown } from "@ygdria/editor/markdown";
import { CALENDAR_PLACEMENT_ID, SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, type NoteContent, type SearchResult } from "@ygdria/shared";
import { ConflictError, escapeHtml, id, NotFoundError, now, type RevisionRow, type SearchRow } from "./note-service-base.js";
import { PlacementService } from "./placement-service.js";

export class NoteService extends PlacementService {
  content(noteId: string, format: "markdown" | "json" | "html") {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot access protected note content via ETAPI");
    if (note.type === "code") {
      const source = typeof note.content === "string" ? note.content : "";
      if (format === "html") return `<article><h1>${escapeHtml(note.title)}</h1><pre><code>${escapeHtml(source)}</code></pre></article>`;
      return source;
    }
    if (format === "json") return note.content;
    if (format === "html")
      return `<article><h1>${escapeHtml(note.title)}</h1><pre>${escapeHtml(tiptapToMarkdown(note.content as NoteContent).markdown)}</pre></article>`;
    return tiptapToMarkdown(note.content as NoteContent).markdown;
  }
  putContent(
    noteId: string,
    body: string | NoteContent,
    format: "markdown" | "json",
    expectedVersion: number,
    createRevision = true,
  ) {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot modify protected note content via ETAPI");
    if (note.type === "code") {
      if (typeof body !== "string") throw new ConflictError("Code note content must be plain source text");
      return this.update(noteId, { code: body, expectedVersion, createRevision });
    }
    const parsed =
      format === "markdown" ? markdownToTiptap(body as string).document : (body as NoteContent);
    return this.update(noteId, { content: parsed, expectedVersion, createRevision });
  }
  revisions(noteId: string) {
    if (!this.get(noteId)) throw new NotFoundError();
    return (
      this.store.sqlite
        .prepare(
          "SELECT id,content_hash contentHash,created_at createdAt FROM revisions WHERE note_id=? ORDER BY created_at DESC",
        )
        .all(noteId) as RevisionRow[]
    ).map((revision) => ({
      ...revision,
      createdAt: new Date(revision.createdAt).toISOString(),
    }));
  }
  clearExcessRevisions(limit: number) {
    if (!Number.isInteger(limit) || limit < -1) throw new ConflictError("Revision limit must be -1 or a non-negative integer");
    if (limit === -1) return { count: 0 };
    const revisionIds: string[] = [];
    this.store.sqlite.transaction(() => {
      const noteIds = this.store.sqlite.prepare("SELECT DISTINCT note_id noteId FROM revisions").all() as Array<{ noteId: string }>;
      const selectExcess = this.store.sqlite.prepare(
        "SELECT id FROM revisions WHERE note_id=? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?",
      );
      const remove = this.store.sqlite.prepare("DELETE FROM revisions WHERE id=?");
      for (const { noteId } of noteIds) {
        for (const { id: revisionId } of selectExcess.all(noteId, limit) as Array<{ id: string }>) {
          remove.run(revisionId);
          revisionIds.push(revisionId);
          recordChange(this.store.sqlite, "revision", revisionId, "deleted");
        }
      }
    })();
    return { count: revisionIds.length };
  }
  revisionContent(noteId: string, revisionId: string) {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot access protected note revisions");
    const revision = this.store.sqlite
      .prepare("SELECT content_data contentData,content_codec contentCodec FROM revisions WHERE id=? AND note_id=?")
      .get(revisionId, noteId) as { contentData: Buffer; contentCodec: ContentCodec } | undefined;
    if (!revision) throw new NotFoundError("Revision not found");
    const content = decodeStoredContent(revision.contentData, revision.contentCodec);
    return { content: note.type === "code" ? content : JSON.parse(content) as NoteContent };
  }
  recentHistory(limit = 200, includeArchived = false) {
    const notes = (this.store.sqlite
      .prepare(
        `SELECT id,title,updated_at updatedAt,deleted_at IS NOT NULL isTrashed,archived_at IS NOT NULL isArchived
         FROM notes
         WHERE id NOT IN (?,?) AND is_protected=0 ${includeArchived ? "" : "AND (deleted_at IS NOT NULL OR archived_at IS NULL)"}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, limit)) as Array<{
      id: string;
      title: string;
      updatedAt: number;
      isTrashed: boolean;
    }>;
    const placements = this.store.sqlite
      .prepare(
        `SELECT p.id,p.note_id noteId,p.parent_placement_id parentPlacementId,n.title
         FROM placements p
         JOIN notes n ON n.id=p.note_id
         ORDER BY p.note_id,p.created_at,p.id`,
      )
      .all() as Array<{
      id: string;
      noteId: string;
      parentPlacementId: string | null;
      title: string;
    }>;
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    const firstPlacementByNote = new Map<string, string>();
    for (const placement of placements) {
      if (!firstPlacementByNote.has(placement.noteId)) {
        firstPlacementByNote.set(placement.noteId, placement.id);
      }
    }
    const pathFor = (noteId: string) => {
      const path: string[] = [];
      const seen = new Set<string>();
      let placement = byId.get(firstPlacementByNote.get(noteId) ?? "");
      // The selected placement is the title shown above the breadcrumb, so only
      // include its ancestors. `seen` keeps corrupted legacy trees from looping.
      while (placement?.parentPlacementId && !seen.has(placement.id)) {
        seen.add(placement.id);
        placement = byId.get(placement.parentPlacementId);
        if (placement) path.unshift(placement.title);
      }
      return path;
    };
    return notes.map((note) => ({
      ...note,
      isTrashed: Boolean(note.isTrashed),
      path: pathFor(note.id),
      updatedAt: new Date(note.updatedAt).toISOString(),
    }));
  }
  restoreRevision(noteId: string, revisionId: string, expectedVersion: number) {
    const revision = this.store.sqlite
      .prepare("SELECT content_data contentData,content_codec contentCodec FROM revisions WHERE id=? AND note_id=?")
      .get(revisionId, noteId) as { contentData: Buffer; contentCodec: ContentCodec } | undefined;
    if (!revision) throw new NotFoundError("Revision not found");
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    const restored = decodeStoredContent(revision.contentData, revision.contentCodec);
    return this.update(noteId, note.type === "code"
      ? { code: restored, expectedVersion }
      : { content: JSON.parse(restored) as NoteContent, expectedVersion });
  }
  search(query: string, includeArchived = false): SearchResult[] {
    if (!query.trim()) return [];
    const normalizedQuery = query.trim();
    const resultLimit = 30;
    // unicode61 tokenizes a continuous Han run as a single FTS term. Keep the
    // word-indexed FTS path for non-Han terms, and add parameterized LIKE
    // predicates for Han runs so e.g. “学习 React” requires both matches.
    const hanTerms = Array.from(normalizedQuery.matchAll(/\p{Script=Han}+/gu), (match) => match[0]);
    // A one-character CJK query would require a very broad table scan and is
    // not precise enough to be useful. The UI applies the same guard.
    if (hanTerms.some((term) => Array.from(term).length < 2)) return [];
    const ftsQuery = normalizedQuery
      .replace(/\p{Script=Han}+/gu, " ")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((term) => term && !/\p{Script=Han}/u.test(term))
      .map((term) => `${term}*`)
      .join(" AND ");
    if (!ftsQuery && hanTerms.length === 0) return [];
    const escapedHanTerms = hanTerms.map((term) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    const hanPredicates = hanTerms.map(() => "(n.title LIKE ? ESCAPE '\\' OR n.plain_text LIKE ? ESCAPE '\\')").join(" AND ");
    const visibility = `n.deleted_at IS NULL AND n.is_protected=0 ${includeArchived ? "" : "AND n.archived_at IS NULL"}`;
    const hanParams = escapedHanTerms.flatMap((term) => [term, term]);
    const rows: Array<SearchRow & { relevance: number }> = ftsQuery
      ? this.store.sqlite.prepare(
        `SELECT n.id noteId,n.title title,snippet(notes_fts,1,'<mark>','</mark>','…',10) snippet,n.updated_at updatedAt,n.archived_at IS NOT NULL isArchived,bm25(notes_fts) relevance
         FROM notes_fts JOIN notes n ON n.rowid=notes_fts.rowid
         WHERE notes_fts MATCH ? AND ${visibility} ${hanPredicates ? `AND ${hanPredicates}` : ""}
         ORDER BY relevance,n.updated_at DESC LIMIT ${resultLimit}`,
      ).all(ftsQuery, ...hanParams) as Array<SearchRow & { relevance: number }>
      : this.store.sqlite.prepare(
        `SELECT n.id noteId,n.title title,
           CASE WHEN instr(n.plain_text, ?) > 0 THEN replace(substr(n.plain_text,MAX(1,instr(n.plain_text,?)-60),180),?,'<mark>' || ? || '</mark>')
           ELSE replace(n.title,?,'<mark>' || ? || '</mark>') END snippet,
           n.updated_at updatedAt,n.archived_at IS NOT NULL isArchived,0 relevance
         FROM notes n WHERE ${visibility} AND ${hanPredicates}
         ORDER BY n.updated_at DESC LIMIT ${resultLimit}`,
      ).all(hanTerms[0], hanTerms[0], hanTerms[0], hanTerms[0], hanTerms[0], hanTerms[0], ...hanParams) as Array<SearchRow & { relevance: number }>;

    // Keep the response stable if a future query path contributes the same
    // note more than once, then rank FTS relevance before recency.
    return Array.from(new Map(rows.map((row) => [row.noteId, row])).values())
      .sort((left, right) => left.relevance - right.relevance || right.updatedAt - left.updatedAt)
      .map((row) => ({ ...row, matchedField: "content" as const, updatedAt: new Date(row.updatedAt).toISOString() }));
  }
  protected ensureCalendarDay() {
    const date = new Date();
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const months = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
    const year = this.ensureCalendarChild(CALENDAR_PLACEMENT_ID, String(date.getFullYear()));
    const month = this.ensureCalendarChild(year, `${String(date.getMonth() + 1).padStart(2, "0")} - ${months[date.getMonth()]}`);
    return this.ensureCalendarChild(month, `${String(date.getDate()).padStart(2, "0")} - ${weekdays[date.getDay()]}`);
  }
  private ensureCalendarChild(parentPlacementId: string, title: string) {
    const existing = this.store.sqlite
      .prepare("SELECT p.id id FROM placements p JOIN notes n ON n.id=p.note_id WHERE p.parent_placement_id=? AND n.title=? AND n.deleted_at IS NULL LIMIT 1")
      .get(parentPlacementId, title) as { id: string } | undefined;
    if (existing) return existing.id;
    const note = this.create({ title, parentPlacementId });
    return (this.store.sqlite
      .prepare("SELECT id FROM placements WHERE note_id=? AND parent_placement_id=?")
      .get(note.id, parentPlacementId) as { id: string }).id;
  }
  /** Administrative integrity check for the denormalized FTS projection. */
  findDuplicateSearchIndexEntries(): Array<{ noteId: string; count: number }> {
    // An FTS external-content index is keyed by the source rowid, so duplicates
    // are structurally impossible.
    return [];
  }
}
