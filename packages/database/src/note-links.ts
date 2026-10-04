import type Database from "better-sqlite3";
import { noteReferenceIdsFromSerializedDocument } from "@ygdria/shared";
import { decodeStoredContent, type ContentCodec } from "./content-codec.js";

/**
 * Derived projection of internal body links. Every `noteReference` node in a
 * note's stored document becomes one (note_id, target_note_id) row, mirroring
 * how notes_fts mirrors searchable text. Consumers (the knowledge graph, the
 * future backlink views) read this table instead of decoding every stored
 * document on demand.
 *
 * Dangling targets are allowed — a note may link to one that was deleted or
 * never existed — so `target_note_id` deliberately has no foreign key. Readers
 * join `notes` when they need only live notes.
 *
 * Maintenance rule: every write path that changes a note's stored content
 * (domain create/update and the sync apply bypass) must call
 * `replaceNoteLinks` inside the same transaction. Deletions need no handling:
 * the cascade on `note_id` removes links with their note.
 */

/** Extract link targets from stored content; [] for protected/code/invalid. */
export function readNoteLinkTargets(contentData: Buffer | Uint8Array, codec: ContentCodec): string[] {
  // Protected bodies are ciphertext and code notes carry plain text — neither
  // can contain a noteReference node, and parsing them is pointless.
  if (codec === "ciphertext-v1") return [];
  try {
    return [...noteReferenceIdsFromSerializedDocument(decodeStoredContent(contentData, codec))];
  } catch {
    return [];
  }
}

/** Replace the stored link rows of one note. Call inside the writing transaction. */
export function replaceNoteLinks(
  sqlite: Database.Database,
  noteId: string,
  contentData: Buffer | Uint8Array,
  codec: ContentCodec,
): void {
  sqlite.prepare("DELETE FROM note_links WHERE note_id=?").run(noteId);
  const insert = sqlite.prepare("INSERT OR IGNORE INTO note_links (note_id,target_note_id) VALUES (?,?)");
  for (const target of readNoteLinkTargets(contentData, codec)) insert.run(noteId, target);
}

/** Recompute the whole projection (maintenance/CLI; wraps its own transaction). */
export function rebuildNoteLinks(sqlite: Database.Database): number {
  const rows = sqlite
    .prepare("SELECT id, content_data contentData, content_codec contentCodec FROM notes WHERE is_protected=0 AND type<>'code'")
    .all() as Array<{ id: string; contentData: Buffer; contentCodec: ContentCodec }>;
  let count = 0;
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM note_links").run();
    const insert = sqlite.prepare("INSERT OR IGNORE INTO note_links (note_id,target_note_id) VALUES (?,?)");
    for (const row of rows) {
      for (const target of readNoteLinkTargets(row.contentData, row.contentCodec)) {
        insert.run(row.id, target);
        count += 1;
      }
    }
  })();
  return count;
}
