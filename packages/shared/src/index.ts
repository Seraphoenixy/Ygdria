import { z } from "zod";

/** Stable IDs for the single system root of every knowledge base. */
export const SYSTEM_ROOT_NOTE_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_ROOT_PLACEMENT_ID = "00000000-0000-4000-8000-000000000002";
export const SYSTEM_TRASH_NOTE_ID = "00000000-0000-4000-8000-000000000003";
export const SYSTEM_TRASH_PLACEMENT_ID = "00000000-0000-4000-8000-000000000004";
export const CALENDAR_NOTE_ID = "00000000-0000-4000-8000-000000000005";
export const CALENDAR_PLACEMENT_ID = "00000000-0000-4000-8000-000000000006";

export const noteTypes = ["text", "code"] as const;
export const noteContentSchema = z
  .object({ type: z.string(), content: z.array(z.unknown()).optional() })
  .passthrough();
export type NoteContent = z.infer<typeof noteContentSchema>;

const attachmentSourcePattern = /^\/api\/v1\/attachments\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:[/?#]|$)/i;

/**
 * Returns attachment IDs referenced by image nodes in a TipTap document.
 * Text, code blocks, and arbitrary node attributes are deliberately ignored:
 * a URL-looking string in those locations is not an attachment reference.
 */
export function attachmentIdsFromDocument(content: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const value = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (value.type === "image" && value.attrs && typeof value.attrs === "object") {
      const src = (value.attrs as { src?: unknown }).src;
      if (typeof src === "string") {
        const match = attachmentSourcePattern.exec(src);
        if (match) ids.add(match[1]);
      }
    }
    if (Array.isArray(value.content)) value.content.forEach(visit);
  };
  visit(content);
  return ids;
}

/** Returns no references when legacy or malformed stored content is not JSON. */
export function attachmentIdsFromSerializedDocument(serialized: string): Set<string> {
  try {
    return attachmentIdsFromDocument(JSON.parse(serialized));
  } catch {
    return new Set<string>();
  }
}

// ---------------------------------------------------------------------------
// Note properties (JSON stored in notes.properties_json)
// ---------------------------------------------------------------------------
export const TAG_MAX_LENGTH = 64;
export const TAG_MAX_COUNT = 20;
export const tagSchema = z.string().min(1).max(TAG_MAX_LENGTH);
export const tagsSchema = z.array(tagSchema).max(TAG_MAX_COUNT);
export type NoteProperties = {
  codeLanguage?: string;
  tags?: string[];
  [key: string]: unknown;
};

export const createNoteSchema = z.object({
  title: z.string().min(1).max(500),
  parentPlacementId: z.string().nullable().optional(),
  type: z.enum(["text", "code"]).optional(),
  content: noteContentSchema.optional(),
  code: z.string().max(10_000_000).optional(),
  tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAG_MAX_COUNT).optional(),
});
export const updateNoteSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  /** Convert between a rich-text note and a raw-source code note. */
  type: z.enum(["text", "code"]).optional(),
  content: noteContentSchema.optional(),
  /** Raw source for a code note. Code notes deliberately do not use TipTap JSON. */
  code: z.string().max(10_000_000).optional(),
  codeLanguage: z.string().min(1).max(64).optional(),
  /** Tags to set on the note. When provided, replaces all existing tags. */
  tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAG_MAX_COUNT).optional(),
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
export const movePlacementsSchema = z.object({
  placementIds: z.array(z.string()).min(1),
  parentPlacementId: z.string(),
  position: z.number().int().nonnegative(),
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
  tags: string[];
  /** Placements inside an ETAPI subtree that contain this note. */
  matchedPlacementIds?: string[];
};

export type TagStats = {
  tag: string;
  count: number;
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

// ---------------------------------------------------------------------------
// Sync data maintenance
// ---------------------------------------------------------------------------
// Replication metadata (change log, cursors, tombstones) and the durable
// attachment cleanup queue are append-mostly tables. They must be bounded
// without ever weakening the guarantees that depend on them:
//
//   * a cursor may only be discarded once the peer is provably stale, because
//     discarding it forces that peer back onto the full snapshot baseline;
//   * a tombstone may only be discarded once every peer that could still push
//     a stale copy has advanced past the change-log entry that carried the
//     deletion — never on age alone;
//   * a cleanup job may only be discarded after it has completed, so retries
//     and orphan rescans keep working exactly as before.

/**
 * How long a sync peer may stay silent before it stops holding back change-log
 * and tombstone pruning. An expired peer's cursor is dropped in the same
 * transaction that lets pruning move past it, so its next sync starts from the
 * snapshot baseline instead of silently resuming from a pruned position.
 */
export const SYNC_PEER_MAX_INACTIVE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Extra grace period a tombstone must reach before it becomes prunable. This
 * is a defence-in-depth floor layered on top of the acknowledgement boundary —
 * age alone never authorises deleting a tombstone.
 */
export const SYNC_TOMBSTONE_MIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Audit window for completed attachment cleanup jobs (30 days). */
export const STORAGE_CLEANUP_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Row counts above which maintenance reports a capacity warning. */
export const SYNC_CHANGE_LOG_WARN_ROWS = 50_000;
export const SYNC_TOMBSTONE_WARN_ROWS = 20_000;
export const STORAGE_CLEANUP_JOB_WARN_PENDING = 200;
/** Attempts after which a cleanup job is reported as persistently failing. */
export const STORAGE_CLEANUP_JOB_FAILURE_ATTEMPTS = 3;

/**
 * Machine-readable error code returned when a sync peer has been away long
 * enough that the server has gated it behind a mandatory snapshot re-baseline.
 * A client receiving this must rebuild from `/api/v1/sync/snapshot` rather than
 * resuming incremental pull/push; it must not surface it as a normal sync error.
 */
export const SYNC_REBASELINE_REQUIRED = "SYNC_REBASELINE_REQUIRED";

/** Machine-readable capacity signals. An empty list means "healthy". */
export type SyncMaintenanceWarning =
  | "change-log-backlog"
  | "change-log-blocked-by-idle-peer"
  | "tombstone-backlog"
  | "storage-cleanup-backlog"
  | "storage-cleanup-failing";

/**
 * Snapshot of everything in the replication metadata that can grow unbounded,
 * plus the reasons it is currently retained.
 *
 * Declared here rather than in the database package so the HTTP client can
 * describe the `/api/v1/maintenance/sync-status` response without depending on
 * SQLite. It is purely observational — reading it never deletes anything.
 */
export type SyncMaintenanceStats = {
  capturedAt: number;
  changeLog: {
    rows: number;
    minId: number | null;
    maxId: number | null;
    oldestCreatedAt: number | null;
    /** Rows already consumed by every active peer, i.e. prunable right now. */
    prunableRows: number;
  };
  tombstones: {
    rows: number;
    /** Tombstones every active peer has acknowledged and that are old enough. */
    prunableRows: number;
    /** Legacy rows with no recorded boundary; these are never pruned. */
    withoutBoundary: number;
    /** Peers currently gated behind a snapshot re-baseline. */
    rebaselineRequiredPeers: number;
    /**
     * Tombstones that are retained specifically because a re-baseline-gated
     * peer has not yet completed its snapshot. Zero means pruning proceeds
     * safely under the gate (gated peers rebuild from current truth, so
     * incremental resurrection is impossible).
     */
    retainedForRebaseline: number;
  };
  peers: {
    total: number;
    active: number;
    expired: number;
    /**
     * Peers the server has gated behind a mandatory snapshot re-baseline
     * because they went silent past the inactivity window. These hold no
     * incremental cursor and must rebuild from the snapshot before resuming.
     */
    rebaselineRequired: number;
    /** MIN(last_advance_id) across all active (non-gated) cursors, null when none. */
    boundary: number | null;
    oldestActivityAt: number | null;
  };
  storageCleanupJobs: {
    pending: number;
    failing: number;
    completed: number;
    /** Completed jobs already past the audit window. */
    prunableCompleted: number;
  };
  placementDeletions: { rows: number };
  database: {
    pageCount: number;
    pageSize: number;
    bytes: number;
    freelistPages: number;
  };
  thresholds: {
    changeLogWarnRows: number;
    tombstoneWarnRows: number;
    storageCleanupWarnPending: number;
    peerMaxInactiveMs: number;
    tombstoneMinRetentionMs: number;
    storageJobRetentionMs: number;
  };
  warnings: SyncMaintenanceWarning[];
};
