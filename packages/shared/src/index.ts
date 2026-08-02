import { z } from "zod";

/** Stable IDs for the single system root of every knowledge base. */
export const SYSTEM_ROOT_NOTE_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_ROOT_PLACEMENT_ID = "00000000-0000-4000-8000-000000000002";
export const SYSTEM_TRASH_NOTE_ID = "00000000-0000-4000-8000-000000000003";
export const SYSTEM_TRASH_PLACEMENT_ID = "00000000-0000-4000-8000-000000000004";
export const CALENDAR_NOTE_ID = "00000000-0000-4000-8000-000000000005";
export const CALENDAR_PLACEMENT_ID = "00000000-0000-4000-8000-000000000006";

export const noteTypes = ["text", "code", "file"] as const;
export const noteContentSchema = z
  .object({ type: z.string(), content: z.array(z.unknown()).optional() })
  .passthrough();
export type NoteContent = z.infer<typeof noteContentSchema>;
export const createNoteSchema = z.object({
  title: z.string().min(1).max(500),
  parentPlacementId: z.string().nullable().optional(),
  type: z.enum(["text", "code"]).optional(),
  content: noteContentSchema.optional(),
  code: z.string().max(10_000_000).optional(),
});
export const updateNoteSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  /** Convert between a rich-text note and a raw-source code note. */
  type: z.enum(["text", "code"]).optional(),
  content: noteContentSchema.optional(),
  /** Raw source for a code note. Code notes deliberately do not use TipTap JSON. */
  code: z.string().max(10_000_000).optional(),
  codeLanguage: z.string().min(1).max(64).optional(),
  /** Client-selected minimum time between revision snapshots; 0 disables throttling. */
  revisionIntervalMs: z.number().int().min(0).max(31_536_000_000).optional(),
  contentCiphertext: z.string().optional(),
  expectedVersion: z.number().int().positive(),
});
export const archiveNoteSchema = z.object({ archived: z.boolean() });
export const restoreRevisionSchema = z.object({
  expectedVersion: z.number().int().positive(),
});
export const placementSchema = z.object({
  noteId: z.string(),
  parentPlacementId: z.string(),
  position: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Note-to-note relations (related / uses / prerequisite)
// ---------------------------------------------------------------------------
export const relationTypes = ["related", "uses", "prerequisite"] as const;
export type RelationType = (typeof relationTypes)[number];
export const relationTypeSchema = z.enum(relationTypes);
export const createRelationSchema = z.object({
  sourceNoteId: z.string().min(1),
  targetNoteId: z.string().min(1),
  relationType: relationTypeSchema,
});
export const relationSchema = z.object({
  id: z.string(),
  sourceNoteId: z.string(),
  targetNoteId: z.string(),
  relationType: relationTypeSchema,
  createdAt: z.number(),
});
export type Relation = z.infer<typeof relationSchema>;
export type ApiError = { error: { code: string; message: string } };
export const emptyDocument: NoteContent = { type: "doc", content: [{ type: "paragraph" }] };

// ---------------------------------------------------------------------------
// Unified master-password authentication model
// ---------------------------------------------------------------------------
// The user maintains a single master password. The client derives two
// independent secrets from it, each with its own random salt and domain
// separation string, so that no key reuse is possible:
//
//   1. File key  — PBKDF2(masterPassword, fileSalt,   FILE_CONTEXT)  → AES-256-GCM
//   2. Access    — PBKDF2(masterPassword, accessSalt, ACCESS_CONTEXT) → accessSecret
//                  then SRP-6a registers/logs in with accessSecret as the password.
//
// The master password, the file key, and accessSecret NEVER leave the client.
// The server only stores the two salts, the SRP verifier, and KDF/protocol
// version metadata. Authentication is a PAKE (SRP-6a) challenge-response;
// no replayable material is ever sent.

/** Fixed SRP-6a "username" (I). The app is single-user; the per-deployment
 *  salt already makes each verifier unique, so a constant identifier is safe. */
export const SRP_USERNAME = "ygdria";
/**
 * Domain-separation string mixed into the access-secret KDF input. The file
 * key path is kept unchanged (PBKDF2(password, fileSalt) → AES-GCM) so that
 * existing protected notes continue to decrypt; its domain separation is the
 * distinct random fileSalt plus the AES-256-GCM key usage. The access path
 * additionally mixes in this context string and feeds SRP-6a, so the two
 * derivations never produce reusable material even for the same password.
 */
export const ACCESS_SECRET_CONTEXT = "ygdria/v1/access-secret";
/** PBKDF2-SHA256 iteration count for both derivations. */
export const MASTER_PASSWORD_PBKDF2_ITERATIONS = 600_000;
/** Derived output length in bits (both file key and access secret). */
export const DERIVED_KEY_BITS = 256;
/** Salt length in bytes for both fileSalt and accessSalt. */
export const SALT_BYTES = 16;
/** Sliding idle timeout for device tokens. Fixed; not configurable. */
export const DEVICE_TOKEN_IDLE_TIMEOUT_MS = 5 * 24 * 60 * 60 * 1000;
/** Master password length bounds (UTF-16 code units). */
export const MIN_MASTER_PASSWORD_LENGTH = 8;
export const MAX_MASTER_PASSWORD_LENGTH = 64;
/** Auth protocol/KDF version persisted to support future migration. */
export const AUTH_PROTOCOL_VERSION = "srp6a-v1";
export const KDF_VERSION = "pbkdf2-sha256-v1";

export type SearchResult = {
  noteId: string;
  title: string;
  snippet: string;
  matchedField: "title" | "content" | "property";
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Placement deletion undo retention
// ---------------------------------------------------------------------------
// Single source of truth for placement-deletion undo record retention. Both
// the in-request prune (NoteService) and the background maintenance task must
// use these values so the undo window the user observes is consistent and is
// not silently shortened by maintenance.

/** Maximum number of placement-deletion undo records to retain. */
export const PLACEMENT_DELETION_MAX_RECORDS = 50;
/** Retention window for placement-deletion undo records (30 days). */
export const PLACEMENT_DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
