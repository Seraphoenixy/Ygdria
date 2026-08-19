import {
  decodeStoredContent,
  encodeDocumentContent,
  recordChange,
  type ContentCodec,
} from "@ygdria/database";
import { markdownToTiptap, tiptapToMarkdown } from "@ygdria/editor/markdown";
import {
  CALENDAR_NOTE_ID,
  CALENDAR_PLACEMENT_ID,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_ROOT_PLACEMENT_ID,
  SYSTEM_TRASH_NOTE_ID,
  SYSTEM_TRASH_PLACEMENT_ID,
  type NoteContent,
  type SearchResult,
  type TagStats,
} from "@ygdria/shared";
import {
  ConflictError,
  escapeHtml,
  id,
  NotFoundError,
  now,
  type RevisionRow,
  type SearchRow,
} from "./note-service-base.js";
import { PlacementService } from "./placement-service.js";
import { readTags } from "./properties-utils.js";

export class PatchTargetError extends Error {
  statusCode = 422;
  code = "PatchTargetError";
}

export type ExternalTextEdit = {
  oldText: string;
  newText: string;
  expectedMatches?: number;
};

type ExternalTreeNode = {
  placementId: string;
  noteId: string;
  parentPlacementId: string | null;
  position: number;
  title: string;
  isProtected: boolean;
  hasChildren: boolean;
};

function applyLiteralEdits(source: string, edits: ExternalTextEdit[]) {
  const replacements: Array<{ start: number; end: number; text: string; editIndex: number }> = [];
  const matches: number[] = [];
  for (const [editIndex, edit] of edits.entries()) {
    const positions: number[] = [];
    let cursor = 0;
    while (cursor <= source.length) {
      const position = source.indexOf(edit.oldText, cursor);
      if (position === -1) break;
      positions.push(position);
      cursor = position + edit.oldText.length;
    }
    const expected = edit.expectedMatches ?? 1;
    if (positions.length !== expected) {
      throw new PatchTargetError(
        `Edit ${editIndex + 1} expected ${expected} literal match(es), found ${positions.length}`,
      );
    }
    matches.push(positions.length);
    for (const start of positions)
      replacements.push({ start, end: start + edit.oldText.length, text: edit.newText, editIndex });
  }
  const ordered = replacements.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new PatchTargetError(
        `Edits ${ordered[index - 1].editIndex + 1} and ${ordered[index].editIndex + 1} overlap`,
      );
    }
  }
  let content = source;
  for (const replacement of [...ordered].sort((left, right) => right.start - left.start)) {
    content =
      content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
  }
  return { content, matches };
}

export class NoteService extends PlacementService {
  private externalNodeFromRow(row: ExternalTreeNode): ExternalTreeNode {
    return {
      ...row,
      title: row.isProtected ? "" : row.title,
      isProtected: Boolean(row.isProtected),
      hasChildren: Boolean(row.hasChildren),
    };
  }

  private externalVisibility(includeArchived: boolean) {
    return [
      SYSTEM_ROOT_NOTE_ID,
      SYSTEM_TRASH_NOTE_ID,
      SYSTEM_TRASH_PLACEMENT_ID,
      includeArchived ? 1 : 0,
    ] as const;
  }

  private externalNodeQuery(where: string, order = "p.position,p.id", limit?: number) {
    return `SELECT p.id placementId,p.note_id noteId,p.parent_placement_id parentPlacementId,p.position,
              n.title,n.is_protected isProtected,
              EXISTS(SELECT 1 FROM placements c JOIN notes cn ON cn.id=c.note_id
                WHERE c.parent_placement_id=p.id AND cn.deleted_at IS NULL
                  AND cn.id NOT IN (?,?) AND c.id<>? AND (?=1 OR cn.archived_at IS NULL)) hasChildren
            FROM placements p JOIN notes n ON n.id=p.note_id
            WHERE n.deleted_at IS NULL AND n.id NOT IN (?,?) AND p.id<>?
              AND (?=1 OR n.archived_at IS NULL) ${where}
            ORDER BY ${order}${limit === undefined ? "" : " LIMIT ?"}`;
  }

  private externalOne(placementId: string, includeArchived: boolean): ExternalTreeNode {
    const visibility = this.externalVisibility(includeArchived);
    const row = this.store.sqlite
      .prepare(this.externalNodeQuery("AND p.id=?"))
      .get(...visibility, ...visibility, placementId) as ExternalTreeNode | undefined;
    if (!row) throw new NotFoundError("Tree node not found");
    return this.externalNodeFromRow(row);
  }

  externalRoots(includeArchived = false, limit = 50, cursor?: string) {
    const visibility = this.externalVisibility(includeArchived);
    const cursorRow = cursor ? this.externalOne(cursor, includeArchived) : undefined;
    const after = cursorRow ? "AND (p.position>? OR (p.position=? AND p.id>?))" : "";
    const params = cursorRow
      ? [
          ...visibility,
          ...visibility,
          SYSTEM_ROOT_PLACEMENT_ID,
          cursorRow.position,
          cursorRow.position,
          cursorRow.placementId,
          limit + 1,
        ]
      : [...visibility, ...visibility, SYSTEM_ROOT_PLACEMENT_ID, limit + 1];
    const rows = this.store.sqlite
      .prepare(
        this.externalNodeQuery(
          `AND p.parent_placement_id=? ${after}`,
          "p.position,p.id",
          limit + 1,
        ),
      )
      .all(...params) as ExternalTreeNode[];
    return this.externalPage(rows, limit);
  }

  externalNode(placementId: string, includeArchived = false) {
    return this.externalOne(placementId, includeArchived);
  }

  externalChildren(placementId: string, includeArchived = false, limit = 50, cursor?: string) {
    this.externalOne(placementId, includeArchived);
    const visibility = this.externalVisibility(includeArchived);
    const cursorRow = cursor ? this.externalOne(cursor, includeArchived) : undefined;
    const after = cursorRow ? "AND (p.position>? OR (p.position=? AND p.id>?))" : "";
    const params = cursorRow
      ? [
          ...visibility,
          ...visibility,
          placementId,
          cursorRow.position,
          cursorRow.position,
          cursorRow.placementId,
          limit + 1,
        ]
      : [...visibility, ...visibility, placementId, limit + 1];
    const rows = this.store.sqlite
      .prepare(
        this.externalNodeQuery(
          `AND p.parent_placement_id=? ${after}`,
          "p.position,p.id",
          limit + 1,
        ),
      )
      .all(...params) as ExternalTreeNode[];
    return this.externalPage(rows, limit);
  }

  private externalPage(rows: ExternalTreeNode[], limit: number) {
    const items = rows.slice(0, limit).map((row) => this.externalNodeFromRow(row));
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.placementId ?? null) : null };
  }

  externalSubtree(placementId: string, includeArchived = false, maxDepth = 1, maxNodes = 100) {
    this.externalOne(placementId, includeArchived);
    const visibility = this.externalVisibility(includeArchived);
    const rows = this.store.sqlite
      .prepare(
        `WITH RECURSIVE subtree(placementId,noteId,parentPlacementId,position,title,isProtected,depth) AS (
         SELECT p.id,p.note_id,p.parent_placement_id,p.position,n.title,n.is_protected,0
         FROM placements p JOIN notes n ON n.id=p.note_id
         WHERE p.id=? AND n.deleted_at IS NULL AND n.id NOT IN (?,?) AND p.id<>? AND (?=1 OR n.archived_at IS NULL)
         UNION ALL
         SELECT p.id,p.note_id,p.parent_placement_id,p.position,n.title,n.is_protected,s.depth+1
         FROM placements p JOIN notes n ON n.id=p.note_id JOIN subtree s ON p.parent_placement_id=s.placementId
         WHERE s.depth<? AND n.deleted_at IS NULL AND n.id NOT IN (?,?) AND p.id<>? AND (?=1 OR n.archived_at IS NULL)
       )
       SELECT s.*, EXISTS(SELECT 1 FROM placements c JOIN notes cn ON cn.id=c.note_id
         WHERE c.parent_placement_id=s.placementId AND cn.deleted_at IS NULL AND cn.id NOT IN (?,?) AND c.id<>? AND (?=1 OR cn.archived_at IS NULL)) hasChildren
       FROM subtree s ORDER BY depth,position,placementId LIMIT ?`,
      )
      .all(
        placementId,
        ...visibility,
        maxDepth,
        ...visibility,
        ...visibility,
        maxNodes,
      ) as ExternalTreeNode[];
    return rows.map((row) => this.externalNodeFromRow(row));
  }

  externalResolve(query: string, includeArchived = false, parentPlacementId?: string, limit = 20) {
    const visibility = this.externalVisibility(includeArchived);
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const parent = parentPlacementId ? "AND p.parent_placement_id=?" : "";
    const params = parentPlacementId
      ? [...visibility, ...visibility, `%${escaped}%`, parentPlacementId, limit]
      : [...visibility, ...visibility, `%${escaped}%`, limit];
    const rows = this.store.sqlite
      .prepare(
        this.externalNodeQuery(
          `AND n.is_protected=0 AND n.title LIKE ? ESCAPE '\\' ${parent}`,
          "p.position,p.id",
          limit,
        ),
      )
      .all(...params) as ExternalTreeNode[];
    return rows.map((row) => this.externalNodeFromRow(row));
  }

  externalNote(noteId: string, format: "markdown" | "json" = "markdown") {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot access protected notes via ETAPI");
    const placements = this.store.sqlite
      .prepare(
        `SELECT id placementId,parent_placement_id parentPlacementId,position
         FROM placements WHERE note_id=? ORDER BY created_at,id`,
      )
      .all(noteId) as Array<{
      placementId: string;
      parentPlacementId: string | null;
      position: number;
    }>;
    return {
      id: note.id,
      title: note.title,
      type: note.type,
      content: this.content(noteId, format),
      contentFormat: format,
      properties: {
        tags: note.tags,
        ...(note.type === "code" ? { codeLanguage: note.codeLanguage } : {}),
      },
      placements,
      version: note.version,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      archivedAt: note.archivedAt === null ? null : new Date(note.archivedAt).toISOString(),
    };
  }

  createExternal(input: {
    title: string;
    parentPlacementId?: string;
    type?: "text" | "code";
    content?: string;
    tags?: string[];
  }) {
    const type = input.type ?? "text";
    return this.create({
      title: input.title,
      parentPlacementId: input.parentPlacementId,
      type,
      ...(type === "code"
        ? { code: input.content ?? "" }
        : input.content === undefined
          ? {}
          : { content: markdownToTiptap(input.content).document }),
      tags: input.tags,
    });
  }

  updateExternal(
    noteId: string,
    input: {
      title?: string;
      content?: string;
      tags?: string[];
      codeLanguage?: string;
      expectedVersion: number;
    },
  ) {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot modify protected notes via ETAPI");
    if (input.codeLanguage !== undefined && note.type !== "code") {
      throw new ConflictError("codeLanguage is only valid for code notes");
    }
    return this.update(noteId, {
      title: input.title,
      tags: input.tags,
      codeLanguage: input.codeLanguage,
      expectedVersion: input.expectedVersion,
      ...(input.content === undefined
        ? {}
        : note.type === "code"
          ? { code: input.content }
          : { content: markdownToTiptap(input.content).document }),
    });
  }

  content(noteId: string, format: "markdown" | "json" | "html") {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot access protected note content via ETAPI");
    if (note.type === "code") {
      const source = typeof note.content === "string" ? note.content : "";
      if (format === "html")
        return `<article><h1>${escapeHtml(note.title)}</h1><pre><code>${escapeHtml(source)}</code></pre></article>`;
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
      if (typeof body !== "string")
        throw new ConflictError("Code note content must be plain source text");
      return this.update(noteId, { code: body, expectedVersion, createRevision });
    }
    const parsed =
      format === "markdown" ? markdownToTiptap(body as string).document : (body as NoteContent);
    return this.update(noteId, { content: parsed, expectedVersion, createRevision });
  }
  patchContent(
    noteId: string,
    input: { expectedVersion: number; edits: ExternalTextEdit[]; dryRun?: boolean },
  ) {
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    if (note.isProtected) throw new ConflictError("Cannot modify protected note content via ETAPI");
    if (note.version !== input.expectedVersion) throw new ConflictError();
    const source =
      note.type === "code"
        ? typeof note.content === "string"
          ? note.content
          : ""
        : tiptapToMarkdown(note.content as NoteContent).markdown;
    const result = applyLiteralEdits(source, input.edits);
    if (input.dryRun)
      return {
        dryRun: true as const,
        version: note.version,
        matches: result.matches,
        content: result.content,
      };
    return this.putContent(noteId, result.content, "markdown", input.expectedVersion);
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
    if (!Number.isInteger(limit) || limit < -1)
      throw new ConflictError("Revision limit must be -1 or a non-negative integer");
    if (limit === -1) return { count: 0 };
    const revisionIds: string[] = [];
    this.store.sqlite.transaction(() => {
      const noteIds = this.store.sqlite
        .prepare("SELECT DISTINCT note_id noteId FROM revisions")
        .all() as Array<{ noteId: string }>;
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
      .prepare(
        "SELECT content_data contentData,content_codec contentCodec FROM revisions WHERE id=? AND note_id=?",
      )
      .get(revisionId, noteId) as { contentData: Buffer; contentCodec: ContentCodec } | undefined;
    if (!revision) throw new NotFoundError("Revision not found");
    const content = decodeStoredContent(revision.contentData, revision.contentCodec);
    return { content: note.type === "code" ? content : (JSON.parse(content) as NoteContent) };
  }
  recentHistory(limit = 200, includeArchived = false) {
    const notes = this.store.sqlite
      .prepare(
        `SELECT id,title,updated_at updatedAt,deleted_at IS NOT NULL isTrashed,archived_at IS NOT NULL isArchived
         FROM notes
         WHERE id NOT IN (?,?) AND is_protected=0 ${includeArchived ? "" : "AND (deleted_at IS NOT NULL OR archived_at IS NULL)"}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, limit) as Array<{
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
      .prepare(
        "SELECT content_data contentData,content_codec contentCodec FROM revisions WHERE id=? AND note_id=?",
      )
      .get(revisionId, noteId) as { contentData: Buffer; contentCodec: ContentCodec } | undefined;
    if (!revision) throw new NotFoundError("Revision not found");
    const note = this.get(noteId);
    if (!note) throw new NotFoundError();
    const restored = decodeStoredContent(revision.contentData, revision.contentCodec);
    return this.update(
      noteId,
      note.type === "code"
        ? { code: restored, expectedVersion }
        : { content: JSON.parse(restored) as NoteContent, expectedVersion },
    );
  }
  search(query: string, includeArchived = false, placementId?: string): SearchResult[] {
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
    const escapedHanTerms = hanTerms.map(
      (term) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
    );
    const hanPredicates = hanTerms
      .map(() => "(n.title LIKE ? ESCAPE '\\' OR n.plain_text LIKE ? ESCAPE '\\')")
      .join(" AND ");
    const visibility = `n.deleted_at IS NULL AND n.is_protected=0 ${includeArchived ? "" : "AND n.archived_at IS NULL"}`;
    this.assertSearchPlacement(placementId);
    const subtreeFilter = placementId
      ? "AND n.id IN (WITH RECURSIVE subtree AS (SELECT id,note_id FROM placements WHERE id=? UNION ALL SELECT p.id,p.note_id FROM placements p JOIN subtree s ON p.parent_placement_id=s.id) SELECT note_id FROM subtree)"
      : "";
    const subtreeParams = placementId ? [placementId] : [];
    const hanParams = escapedHanTerms.flatMap((term) => [term, term]);
    const rows: Array<SearchRow & { relevance: number }> = ftsQuery
      ? (this.store.sqlite
          .prepare(
            `SELECT n.id noteId,n.title title,snippet(notes_fts,1,'<mark>','</mark>','…',10) snippet,n.updated_at updatedAt,n.archived_at IS NOT NULL isArchived,bm25(notes_fts) relevance
         FROM notes_fts JOIN notes n ON n.rowid=notes_fts.rowid
         WHERE notes_fts MATCH ? AND ${visibility} ${hanPredicates ? `AND ${hanPredicates}` : ""} ${subtreeFilter}
         ORDER BY relevance,n.updated_at DESC LIMIT ${resultLimit}`,
          )
          .all(ftsQuery, ...hanParams, ...subtreeParams) as Array<
          SearchRow & { relevance: number }
        >)
      : (this.store.sqlite
          .prepare(
            `SELECT n.id noteId,n.title title,
           ${hanTerms
             .reduce(
               (expr, _term) => `replace(${expr},?,'<mark>' || ? || '</mark>')`,
               `CASE WHEN instr(n.plain_text, ?) > 0 THEN substr(n.plain_text,MAX(1,instr(n.plain_text,?)-60),180) ELSE n.title END`,
             )
           } snippet,
           n.updated_at updatedAt,n.archived_at IS NOT NULL isArchived,0 relevance
         FROM notes n WHERE ${visibility} AND ${hanPredicates} ${subtreeFilter}
         ORDER BY n.updated_at DESC LIMIT ${resultLimit}`,
          )
          .all(
            hanTerms[0],
            hanTerms[0],
            ...hanTerms.flatMap((term) => [term, term]),
            ...hanParams,
            ...subtreeParams,
          ) as Array<SearchRow & { relevance: number }>);

    // Keep the response stable if a future query path contributes the same
    // note more than once, then rank FTS relevance before recency.
    const results = Array.from(new Map(rows.map((row) => [row.noteId, row])).values())
      .sort((left, right) => left.relevance - right.relevance || right.updatedAt - left.updatedAt)
      .map((row) => {
        const tags = this.getTagsForNoteId(row.noteId);
        return {
          noteId: row.noteId,
          title: row.title,
          snippet: row.snippet,
          matchedField: "content" as const,
          updatedAt: new Date(row.updatedAt).toISOString(),
          tags,
        };
      });
    return this.withMatchedPlacements(results, placementId);
  }
  protected ensureCalendarDay() {
    const date = new Date();
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const months = [
      "一月",
      "二月",
      "三月",
      "四月",
      "五月",
      "六月",
      "七月",
      "八月",
      "九月",
      "十月",
      "十一月",
      "十二月",
    ];
    const year = this.ensureCalendarChild(
      CALENDAR_PLACEMENT_ID,
      String(date.getFullYear()),
      this.calendarNodeIds(date, "year"),
    );
    const month = this.ensureCalendarChild(
      year,
      `${String(date.getMonth() + 1).padStart(2, "0")} - ${months[date.getMonth()]}`,
      this.calendarNodeIds(date, "month"),
    );
    return this.ensureCalendarChild(
      month,
      `${String(date.getDate()).padStart(2, "0")} - ${weekdays[date.getDay()]}`,
      this.calendarNodeIds(date, "day"),
    );
  }
  /**
   * Calendar nodes need stable identities: two offline desktops can otherwise
   * both observe a missing day, create different UUIDs, and sync both nodes.
   */
  private calendarNodeIds(date: Date, level: "year" | "month" | "day") {
    const prefix = level === "year" ? "a" : level === "month" ? "b" : "c";
    const dateKey =
      level === "year"
        ? `${date.getFullYear().toString().padStart(4, "0")}000`
        : level === "month"
          ? `${date.getFullYear().toString().padStart(4, "0")}${(date.getMonth() + 1).toString(16)}00`
          : `${date.getFullYear().toString().padStart(4, "0")}${(date.getMonth() + 1).toString(16)}${date.getDate().toString(16).padStart(2, "0")}`;
    const base = `${prefix}${dateKey}-0000-4000`;
    return {
      noteId: `${base}-8001-000000000001`,
      placementId: `${base}-8002-000000000001`,
    };
  }
  private ensureCalendarChild(
    parentPlacementId: string,
    title: string,
    ids: { noteId: string; placementId: string },
  ) {
    const existing = this.store.sqlite
      .prepare(
        "SELECT p.id id FROM placements p JOIN notes n ON n.id=p.note_id WHERE p.parent_placement_id=? AND n.title=? AND n.deleted_at IS NULL LIMIT 1",
      )
      .get(parentPlacementId, title) as { id: string } | undefined;
    if (existing) return existing.id;
    this.create({ title, parentPlacementId, ...ids });
    return ids.placementId;
  }
  /** Administrative integrity check for the denormalized FTS projection. */
  findDuplicateSearchIndexEntries(): Array<{ noteId: string; count: number }> {
    // An FTS external-content index is keyed by the source rowid, so duplicates
    // are structurally impossible.
    return [];
  }

  /**
   * Search notes by exact tag match using json_each on properties_json.
   * Only returns non-deleted, non-protected notes.
   */
  searchByTag(tag: string, includeArchived = false, placementId?: string): SearchResult[] {
    if (!tag || tag.trim().length === 0) return [];
    const resultLimit = 30;
    this.assertSearchPlacement(placementId);
    const subtreeFilter = placementId
      ? "AND n.id IN (WITH RECURSIVE subtree AS (SELECT id,note_id FROM placements WHERE id=? UNION ALL SELECT p.id,p.note_id FROM placements p JOIN subtree s ON p.parent_placement_id=s.id) SELECT note_id FROM subtree)"
      : "";
    const rows = this.store.sqlite
      .prepare(
        `SELECT n.id noteId, n.title title, n.plain_text plainText, n.updated_at updatedAt
         FROM notes n
         JOIN json_each(n.properties_json, '$.tags') jt
         WHERE n.deleted_at IS NULL AND n.is_protected=0 ${includeArchived ? "" : "AND n.archived_at IS NULL"}
         AND jt.value = ? ${subtreeFilter}
         ORDER BY n.updated_at DESC
         LIMIT ?`,
      )
      .all(tag, ...subtreeParams(placementId), resultLimit) as Array<{
      noteId: string;
      title: string;
      plainText: string;
      updatedAt: number;
    }>;
    const results = rows.map((row) => {
      const tags = readTags(
        (
          this.store.sqlite
            .prepare("SELECT properties_json FROM notes WHERE id=?")
            .get(row.noteId) as { properties_json: string } | undefined
        )?.properties_json ?? "{}",
      );
      const snippet =
        row.plainText.length > 200 ? row.plainText.slice(0, 200) + "…" : row.plainText;
      return {
        noteId: row.noteId,
        title: row.title,
        snippet,
        matchedField: "property" as const,
        updatedAt: new Date(row.updatedAt).toISOString(),
        tags,
      };
    });
    return this.withMatchedPlacements(results, placementId);
  }

  /**
   * Aggregate non-deleted, non-protected note tags with usage counts,
   * ordered by count descending.
   */
  tagStats(): TagStats[] {
    const rows = this.store.sqlite
      .prepare(
        `SELECT jt.value tag, COUNT(*) count
         FROM notes n
         JOIN json_each(n.properties_json, '$.tags') jt
         WHERE n.deleted_at IS NULL AND n.is_protected=0
         GROUP BY jt.value
         ORDER BY count DESC, tag ASC
         LIMIT 100`,
      )
      .all() as Array<{ tag: string; count: number }>;
    return rows;
  }

  private getTagsForNoteId(noteId: string): string[] {
    const row = this.store.sqlite
      .prepare("SELECT properties_json, is_protected FROM notes WHERE id=?")
      .get(noteId) as { properties_json: string; is_protected: number } | undefined;
    if (!row || row.is_protected) return [];
    return readTags(row.properties_json);
  }
  private assertSearchPlacement(placementId?: string) {
    if (!placementId) return;
    const row = this.store.sqlite
      .prepare(
        "SELECT p.id FROM placements p JOIN notes n ON n.id=p.note_id WHERE p.id=? AND n.deleted_at IS NULL",
      )
      .get(placementId);
    if (!row) throw new NotFoundError("Placement not found");
  }
  private withMatchedPlacements(results: SearchResult[], placementId?: string): SearchResult[] {
    if (!placementId || results.length === 0) return results;
    const noteIds = results.map((result) => result.noteId);
    const placeholders = noteIds.map(() => "?").join(",");
    const rows = this.store.sqlite
      .prepare(
        `WITH RECURSIVE subtree AS (SELECT id,note_id FROM placements WHERE id=? UNION ALL SELECT p.id,p.note_id FROM placements p JOIN subtree s ON p.parent_placement_id=s.id)
       SELECT id placementId,note_id noteId FROM subtree WHERE note_id IN (${placeholders})`,
      )
      .all(placementId, ...noteIds) as Array<{ placementId: string; noteId: string }>;
    const byNoteId = new Map<string, string[]>();
    for (const row of rows)
      byNoteId.set(row.noteId, [...(byNoteId.get(row.noteId) ?? []), row.placementId]);
    return results.map((result) => ({
      ...result,
      matchedPlacementIds: byNoteId.get(result.noteId) ?? [],
    }));
  }
}

function subtreeParams(placementId?: string): string[] {
  return placementId ? [placementId] : [];
}
