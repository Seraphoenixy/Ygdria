import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import {
  noteContentSchema,
  noteTypes,
  SYSTEM_ROOT_NOTE_ID,
  SYSTEM_TRASH_NOTE_ID,
  type NoteContent,
} from "@ygdria/shared";
import { inspectSearchIndex, rebuildSearchIndex, type SearchIndexDiagnostics } from "./search-index.js";
import { decodeStoredContent, type ContentCodec } from "./content-codec.js";

type DoctorIssue = { kind: string; ids?: string[]; count?: number; detail?: string };
export type DoctorReport = {
  sqliteIntegrity: string[];
  foreignKeyViolations: unknown[];
  searchIndex: SearchIndexDiagnostics;
  issues: DoctorIssue[];
};
export type DoctorFixReport = {
  rebuiltSearchIndex: boolean;
  rebuiltPlainTextCount: number;
  removedTemporaryFiles: number;
  renumberedPlacementCount: number;
  markdownCache: "not-applicable";
};

type NoteRow = {
  id: string;
  type: string;
  content_data: Buffer;
  content_codec: ContentCodec;
  content_hash: string;
  plain_text: string;
  is_protected: number;
};

/** Checks SQLite invariants plus Ygdria's denormalized and filesystem projections. */
export async function inspectDatabase(
  sqlite: Database.Database,
  storageRoot = process.cwd(),
): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const integrity = sqlite.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  const foreignKeyViolations = sqlite.prepare("PRAGMA foreign_key_check").all();
  const notes = sqlite.prepare("SELECT id,type,content_data,content_codec,content_hash,plain_text,is_protected FROM notes").all() as NoteRow[];
  const invalidJson: string[] = [];
  const invalidContent: string[] = [];
  const hashMismatch: string[] = [];
  const plainTextMismatch: string[] = [];
  const unknownTypes: string[] = [];

  for (const note of notes) {
    if (!noteTypes.includes(note.type as (typeof noteTypes)[number])) unknownTypes.push(note.id);
    if (note.is_protected) continue;
    const content = parseContent(decodeStoredContent(note.content_data, note.content_codec));
    if (content === null) {
      invalidJson.push(note.id);
      continue;
    }
    if (!noteContentSchema.safeParse(content).success) invalidContent.push(note.id);
    if (stableContentHash(content) !== note.content_hash) hashMismatch.push(note.id);
    if (plainText(content) !== note.plain_text) plainTextMismatch.push(note.id);
  }

  const invalidRevisions = (sqlite
    .prepare("SELECT id,content_data,content_codec,content_hash FROM revisions")
    .all() as Array<{ id: string; content_data: Buffer; content_codec: ContentCodec; content_hash: string }>)
    .filter((revision) => {
      const content = parseContent(decodeStoredContent(revision.content_data, revision.content_codec));
      return content === null || !noteContentSchema.safeParse(content).success || stableContentHash(content) !== revision.content_hash;
    })
    .map((revision) => revision.id);

  const unplacedNotes = (sqlite
    .prepare(`SELECT n.id FROM notes n WHERE n.id NOT IN (?,?) AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.note_id=n.id)`)
    .all(SYSTEM_ROOT_NOTE_ID, SYSTEM_TRASH_NOTE_ID) as Array<{ id: string }>)
    .map((row) => row.id);
  const placementCycles = findPlacementCycles(
    sqlite.prepare("SELECT id,parent_placement_id parentId FROM placements").all() as Array<{ id: string; parentId: string | null }>,
  );
  const attachmentIssues = await inspectAttachments(sqlite, storageRoot);

  addIssue(issues, "invalid-content-json", invalidJson);
  addIssue(issues, "content-schema-invalid", invalidContent);
  addIssue(issues, "content-hash-mismatch", hashMismatch);
  addIssue(issues, "plain-text-mismatch", plainTextMismatch);
  addIssue(issues, "unknown-note-type", unknownTypes);
  addIssue(issues, "invalid-revision", invalidRevisions);
  addIssue(issues, "unplaced-note", unplacedNotes);
  addIssue(issues, "placement-cycle", placementCycles);
  for (const issue of attachmentIssues) issues.push(issue);

  const searchIndex = inspectSearchIndex(sqlite);
  if (searchIndex.missingIndexCount) issues.push({ kind: "fts-missing", count: searchIndex.missingIndexCount });
  if (searchIndex.deletedNoteIndexCount) issues.push({ kind: "fts-deleted-note-residue", count: searchIndex.deletedNoteIndexCount });
  if (searchIndex.danglingIndexCount) issues.push({ kind: "fts-dangling", count: searchIndex.danglingIndexCount });
  if (searchIndex.duplicateNoteIds.length) issues.push({ kind: "fts-duplicate", ids: searchIndex.duplicateNoteIds.map((row) => row.noteId) });

  return {
    sqliteIntegrity: integrity.map((row) => row.integrity_check),
    foreignKeyViolations,
    searchIndex,
    issues,
  };
}

/** Applies only deterministic, non-authoritative projection repairs. */
export function fixDatabase(
  sqlite: Database.Database,
  storageRoot = process.cwd(),
): DoctorFixReport {
  const rebuiltPlainTextCount = rebuildPlainText(sqlite);
  const renumberedPlacementCount = renumberPlacements(sqlite);
  const removedTemporaryFiles = cleanTemporaryFiles(
    resolve(storageRoot, "attachments-tmp"),
  );
  rebuildSearchIndex(sqlite);
  return {
    rebuiltSearchIndex: true,
    rebuiltPlainTextCount,
    removedTemporaryFiles,
    renumberedPlacementCount,
    markdownCache: "not-applicable",
  };
}

function addIssue(issues: DoctorIssue[], kind: string, ids: string[]) {
  if (ids.length) issues.push({ kind, ids, count: ids.length });
}

function parseContent(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stableContentHash(content: unknown) {
  return createHash("sha256").update(stableJson(content)).digest("hex");
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

function plainText(content: unknown) {
  const output: string[] = [];
  const visit = (node: any) => {
    if (node?.type === "text" && typeof node.text === "string") output.push(node.text);
    if (node?.type === "noteReference" && typeof node.attrs?.title === "string") output.push(node.attrs.title);
    if (Array.isArray(node?.content)) node.content.forEach(visit);
  };
  visit(content as NoteContent);
  return output.join(" ");
}

function findPlacementCycles(rows: Array<{ id: string; parentId: string | null }>) {
  const parents = new Map(rows.map((row) => [row.id, row.parentId]));
  const cyclic = new Set<string>();
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = start;
    while (current) {
      if (seen.has(current)) {
        for (const id of seen) cyclic.add(id);
        break;
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
  return [...cyclic];
}

async function inspectAttachments(sqlite: Database.Database, storageRoot: string): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  const hashMismatch: string[] = [];
  const unsafeKey: string[] = [];
  const root = resolve(storageRoot);
  const rows = sqlite
    .prepare("SELECT id,storage_key storageKey,size,content_hash contentHash FROM attachments")
    .all() as Array<{ id: string; storageKey: string; size: number; contentHash: string }>;
  for (const attachment of rows) {
    const file = resolve(root, attachment.storageKey);
    if (!isWithin(root, file)) {
      unsafeKey.push(attachment.id);
      continue;
    }
    if (!existsSync(file)) {
      missing.push(attachment.id);
      continue;
    }
    if (statSync(file).size !== attachment.size) sizeMismatch.push(attachment.id);
    if (hashFile(file) !== attachment.contentHash) hashMismatch.push(attachment.id);
  }
  addIssue(issues, "attachment-file-missing", missing);
  addIssue(issues, "attachment-size-mismatch", sizeMismatch);
  addIssue(issues, "attachment-hash-mismatch", hashMismatch);
  addIssue(issues, "attachment-storage-key-unsafe", unsafeKey);
  return issues;
}

function hashFile(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isWithin(root: string, target: string) {
  const path = relative(root, target);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !path.includes(`..${sep}`);
}

function rebuildPlainText(sqlite: Database.Database) {
  const rows = sqlite.prepare("SELECT id,content_data,content_codec,plain_text,is_protected FROM notes").all() as Array<{ id: string; content_data: Buffer; content_codec: ContentCodec; plain_text: string; is_protected: number }>;
  const updates = rows.flatMap((row) => {
    if (row.is_protected) return [];
    const content = parseContent(decodeStoredContent(row.content_data, row.content_codec));
    if (content === null || !noteContentSchema.safeParse(content).success) return [];
    const value = plainText(content);
    return value === row.plain_text ? [] : [{ id: row.id, value }];
  });
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const update = sqlite.prepare("UPDATE notes SET plain_text=? WHERE id=?");
    for (const row of updates) update.run(row.value, row.id);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  return updates.length;
}

function renumberPlacements(sqlite: Database.Database) {
  const rows = sqlite
    .prepare("SELECT id,parent_placement_id parentId,position FROM placements ORDER BY parent_placement_id,position,id")
    .all() as Array<{ id: string; parentId: string | null; position: number }>;
  const next = new Map<string, number>();
  const updates: Array<{ id: string; position: number }> = [];
  for (const row of rows) {
    const key = row.parentId ?? "__root__";
    const position = next.get(key) ?? 0;
    next.set(key, position + 1);
    if (row.position !== position) updates.push({ id: row.id, position });
  }
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const update = sqlite.prepare("UPDATE placements SET position=?,updated_at=? WHERE id=?");
    const timestamp = Date.now();
    for (const row of updates) update.run(row.position, timestamp, row.id);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  return updates.length;
}

function cleanTemporaryFiles(tempRoot: string) {
  if (!existsSync(tempRoot)) return 0;
  if (lstatSync(tempRoot).isSymbolicLink()) {
    throw new Error("Temporary attachment root must not be a symbolic link");
  }
  let removed = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const entry = resolve(directory, name);
      const stat = lstatSync(entry);
      if (stat.isDirectory()) {
        visit(entry);
        rmSync(entry);
      } else {
        rmSync(entry);
        removed += 1;
      }
    }
  };
  visit(resolve(tempRoot));
  return removed;
}
