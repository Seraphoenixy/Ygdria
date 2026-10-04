import { randomUUID } from "node:crypto";
import { recordChange, type createDatabase } from "@ygdria/database";
import {
  CALENDAR_NOTE_ID,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_TRASH_NOTE_ID,
  type GraphData,
  type GraphEdge,
  type GraphEdgeKind,
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
    const peer = (
      row: Relation & { targetTitle?: string; sourceTitle?: string },
      isOutgoing: boolean,
    ): RelationWithPeer => ({
      id: row.id,
      sourceNoteId: row.sourceNoteId,
      targetNoteId: row.targetNoteId,
      relationType: row.relationType as RelationType,
      createdAt: row.createdAt,
      peerTitle: (
        isOutgoing
          ? row.targetTitle ?? row.targetNoteId
          : row.sourceTitle ?? row.sourceNoteId
      ) as string,
    });
    return {
      outgoing: outgoingRows.map((row) => peer(row, true)),
      incoming: incomingRows.map((row) => peer(row, false)),
    };
  }

  /**
   * Read-only projection for the knowledge graph view: every non-deleted,
   * non-system note as a node, explicit relations and internal body links
   * (noteReference nodes) as edges. Protected notes appear as title-less
   * nodes — their stored content is ciphertext only the holding client can
   * decrypt, so their body links are invisible here.
   */
  graph(): GraphData {
    const nodes = (
      this.store.sqlite
        .prepare(
          "SELECT id,CASE WHEN is_protected=1 THEN '' ELSE title END title,is_protected isProtected FROM notes WHERE deleted_at IS NULL AND id NOT IN (?,?,?) ORDER BY title,id",
        )
        .all(SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID, CALENDAR_NOTE_ID) as Array<{
        id: string;
        title: string;
        isProtected: number;
      }>
    ).map((row) => ({ id: row.id, title: row.title, isProtected: Boolean(row.isProtected) }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = new Map<string, GraphEdge>();
    const addEdge = (source: string, target: string, kind: GraphEdgeKind) => {
      if (source === target || !nodeIds.has(source) || !nodeIds.has(target)) return;
      edges.set(`${kind}:${source}:${target}`, { source, target, kind });
    };
    for (const row of this.store.sqlite
      .prepare("SELECT source_note_id sourceNoteId,target_note_id targetNoteId FROM relations")
      .all() as Array<{ sourceNoteId: string; targetNoteId: string }>)
      addEdge(row.sourceNoteId, row.targetNoteId, "relation");
    // Body links come from the note_links projection (kept in step with every
    // content write), so this read never decodes stored documents. The join
    // drops links whose source note is deleted; dangling targets are filtered
    // by addEdge's node-membership check.
    for (const row of this.store.sqlite
      .prepare(
        "SELECT l.note_id sourceNoteId, l.target_note_id targetNoteId FROM note_links l JOIN notes n ON n.id = l.note_id WHERE n.deleted_at IS NULL AND n.is_protected = 0",
      )
      .all() as Array<{ sourceNoteId: string; targetNoteId: string }>)
      addEdge(row.sourceNoteId, row.targetNoteId, "link");
    return { nodes, edges: [...edges.values()] };
  }
}
