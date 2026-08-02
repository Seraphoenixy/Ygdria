import { randomUUID } from "node:crypto";
import { recordChange, type createDatabase } from "@ygdria/database";
import {
  CALENDAR_NOTE_ID,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_TRASH_NOTE_ID,
  type RelationType,
} from "@ygdria/shared";
import { NotFoundError } from "./note-service-base.js";

type Store = ReturnType<typeof createDatabase>;

/** Notes that must never become a relation endpoint. */
const RESERVED_NOTE_IDS = new Set([SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID]);

export interface Relation {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  relationType: RelationType;
  createdAt: number;
}

export interface RelationWithPeer {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  relationType: RelationType;
  createdAt: number;
  /** Title of the *other* note in the pair, for display in the UI. */
  peerTitle: string;
}

/**
 * Manages directed edges between notes (`related` / `uses` / `prerequisite`).
 * Relations have no mutable payload, so every mutation is recorded as a
 * `created`/`deleted` sync change and replayed idempotently across peers.
 */
export class RelationService {
  constructor(private store: Store) {}

  private assertEndpoint(noteId: string) {
    if (RESERVED_NOTE_IDS.has(noteId)) throw new NotFoundError("Reserved notes cannot be linked");
  }

  private noteExists(noteId: string): boolean {
    const row = this.store.sqlite
      .prepare("SELECT 1 FROM notes WHERE id=? AND deleted_at IS NULL")
      .get(noteId) as { 1: number } | undefined;
    return Boolean(row);
  }

  /** Create a directed relation. Returns the created relation, or `null` when
   *  an identical edge already exists (the unique index absorbs duplicates). */
  createRelation(sourceNoteId: string, targetNoteId: string, relationType: RelationType): Relation | null {
    if (sourceNoteId === targetNoteId) throw new NotFoundError("A note cannot relate to itself");
    this.assertEndpoint(sourceNoteId);
    this.assertEndpoint(targetNoteId);
    if (!this.noteExists(sourceNoteId)) throw new NotFoundError("Source note not found");
    if (!this.noteExists(targetNoteId)) throw new NotFoundError("Target note not found");

    const id = randomUUID();
    const t = Date.now();
    let created: Relation | null = null;
    this.store.sqlite.transaction(() => {
      const result = this.store.sqlite
        .prepare(
          "INSERT OR IGNORE INTO relations (id,source_note_id,target_note_id,relation_type,created_at) VALUES (?,?,?,?,?)",
        )
        .run(id, sourceNoteId, targetNoteId, relationType, t);
      if (result.changes === 0) return;
      recordChange(this.store.sqlite, "relation", id, "created");
      created = { id, sourceNoteId, targetNoteId, relationType, createdAt: t };
    })();
    return created;
  }

  deleteRelation(id: string): void {
    const existing = this.store.sqlite
      .prepare("SELECT 1 FROM relations WHERE id=?")
      .get(id) as { 1: number } | undefined;
    if (!existing) throw new NotFoundError("Relation not found");
    // The AFTER DELETE trigger writes the sync tombstone automatically.
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("DELETE FROM relations WHERE id=?").run(id);
      recordChange(this.store.sqlite, "relation", id, "deleted");
    })();
  }

  /** List every relation touching `noteId`: outgoing (this note is the source)
   *  and incoming (this note is the target — i.e. backlinks). */
  listRelations(noteId: string): { outgoing: RelationWithPeer[]; incoming: RelationWithPeer[] } {
    const titleLookup = new Map<string, string>();
    const outgoingRows = this.store.sqlite
      .prepare(
        "SELECT r.id,r.source_note_id sourceNoteId,r.target_note_id targetNoteId,r.relation_type relationType,r.created_at createdAt,n.title targetTitle FROM relations r JOIN notes n ON n.id=r.target_note_id WHERE r.source_note_id=? ORDER BY r.created_at",
      )
      .all(noteId) as Array<Relation & { targetTitle: string }>;
    const incomingRows = this.store.sqlite
      .prepare(
        "SELECT r.id,r.source_note_id sourceNoteId,r.target_note_id targetNoteId,r.relation_type relationType,r.created_at createdAt,n.title sourceTitle FROM relations r JOIN notes n ON n.id=r.source_note_id WHERE r.target_note_id=? ORDER BY r.created_at",
      )
      .all(noteId) as Array<Relation & { sourceTitle: string }>;
    for (const row of outgoingRows) titleLookup.set(row.targetNoteId, row.targetTitle);
    for (const row of incomingRows) titleLookup.set(row.sourceNoteId, row.sourceTitle);
    const peer = (row: Relation & { targetTitle?: string; sourceTitle?: string }): RelationWithPeer => ({
      id: row.id,
      sourceNoteId: row.sourceNoteId,
      targetNoteId: row.targetNoteId,
      relationType: row.relationType as RelationType,
      createdAt: row.createdAt,
      peerTitle: (row.targetTitle ?? row.sourceTitle ?? row.targetNoteId) as string,
    });
    return {
      outgoing: outgoingRows.map(peer),
      incoming: incomingRows.map(peer),
    };
  }
}
