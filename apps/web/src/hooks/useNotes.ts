import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../lib/i18n";
import { readSettings, type TimeUnit } from "../features/settings/settingsStore";

function durationMs(value: number, unit: TimeUnit) {
  const multiplier = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[unit];
  return Math.max(0, Math.floor(value)) * multiplier;
}

// Trailing debounce for the autosave: collapse a burst of keystrokes into a
// single network write once typing settles.
const SAVE_DEBOUNCE_MS = 1000;

type UseNotesOptions = {
  client: YgdriaClient;
  selected?: string;
  selectedTrashed?: boolean;
  settingsOpen: boolean;
  activeTabId?: string;
  locale: Locale;
  dataAccessReady: boolean;
  onNoteCreated: (noteId: string, parentPlacementId?: string | null) => void;
  onNoteRestored: (noteId: string) => void;
};

type ContentSaveRequest = {
  noteId: string;
  expectedVersion: number;
  type?: "text" | "code" | "file";
  isProtected?: boolean;
  content: any;
};

/** A note save that the server rejected because the note changed elsewhere. */
export type SaveConflict = {
  noteId: string;
  type?: "text" | "code";
  isProtected?: boolean;
  localContent: any;
};

function isConflictError(error: unknown): boolean {
  const e = error as { code?: string; statusCode?: number } | null;
  return e?.code === "ConflictError" || e?.statusCode === 409;
}

export function useNotes({
  client,
  selected,
  selectedTrashed,
  settingsOpen,
  activeTabId,
  locale,
  dataAccessReady,
  onNoteCreated,
  onNoteRestored,
}: UseNotesOptions) {
  const qc = useQueryClient();
  // This must survive renders. A local variable creates a fresh timer for each
  // render, leaving an older editor's delayed save alive to overwrite content.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Start of the current autosave window. Used as a max-wait boundary so that
  // uninterrupted typing still flushes at most once per snapshot interval.
  const autoSaveWindowStartRef = useRef<number | undefined>(undefined);

  const tree = useQuery({ queryKey: ["tree"], queryFn: () => client.tree(), retry: 1, enabled: dataAccessReady });

  const note = useQuery({
    queryKey: ["note", selected, selectedTrashed],
    queryFn: () => (selectedTrashed ? client.getTrashedNote(selected!) : client.getNote(selected!)),
    enabled: dataAccessReady && !!selected && !settingsOpen,
  });

  const history = useQuery({
    queryKey: ["history"],
    queryFn: () => client.history(),
    enabled: dataAccessReady && activeTabId === "history",
  });

  const archivedNotes = useQuery({
    queryKey: ["archived"],
    queryFn: () => client.archived(),
    enabled: dataAccessReady && activeTabId === "archive",
  });

  const attachments = useQuery({
    queryKey: ["attachments"],
    queryFn: () => client.listAttachments(),
    enabled: dataAccessReady && activeTabId === "attachments",
  });

  const archiveNote = useMutation({
    mutationFn: ({ noteId, archived }: { noteId: string; archived: boolean }) =>
      client.archiveNote(noteId, archived),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["archived"] });
      qc.invalidateQueries({ queryKey: ["history"] });
      qc.invalidateQueries({ queryKey: ["note", selected] });
    },
  });

  const createNote = useMutation({
    mutationFn: ({ parentPlacementId, type = "text" }: { parentPlacementId?: string; type?: "text" | "code" }) => {
      const title = t(locale, type === "code" ? "untitledCodeNote" : "untitledNote");
      if (type === "code") return client.createNote({ title, parentPlacementId, type });
      return parentPlacementId
        ? client.createNote({ title, parentPlacementId, type })
        : client.createTodayNote({ title });
    },
    onSuccess: (n, variables) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["history"] });
      onNoteCreated(n.id, variables.parentPlacementId);
    },
  });

  const save = useMutation({
    mutationFn: ({ noteId, expectedVersion, type, isProtected, content: contentOrCiphertext }: ContentSaveRequest) => {
      const settings = readSettings();
      const revisionIntervalMs = durationMs(settings.revisionIntervalMinutes, settings.revisionIntervalUnit);
      if (isProtected && typeof contentOrCiphertext === "string") {
        return client.updateNote(noteId, { contentCiphertext: contentOrCiphertext, expectedVersion });
      }
      if (type === "code" && typeof contentOrCiphertext === "string") {
        return client.updateNote(noteId, { code: contentOrCiphertext, revisionIntervalMs, expectedVersion });
      }
      if (type === "code" && contentOrCiphertext && typeof contentOrCiphertext.code === "string") {
        return client.updateNote(noteId, { code: contentOrCiphertext.code, codeLanguage: contentOrCiphertext.codeLanguage, revisionIntervalMs, expectedVersion });
      }
      return client.updateNote(noteId, { content: contentOrCiphertext, revisionIntervalMs, expectedVersion });
    },
    onSuccess: (_updated, request) => {
      qc.invalidateQueries({ queryKey: ["note", request.noteId] });
      qc.invalidateQueries({ queryKey: ["history"] });
      const { revisionLimit } = readSettings();
      if (Number.isInteger(revisionLimit) && revisionLimit >= 0) void client.clearExcessRevisions(revisionLimit);
    },
    onError: (error, request) => {
      // The note was modified elsewhere (another device via sync, or a second
      // tab) so the optimistic-lock version no longer matches. Surface it as a
      // resolvable conflict instead of silently dropping the user's edits.
      if (isConflictError(error)) {
        setConflict({
          noteId: request.noteId,
          type: request.type === "code" ? "code" : "text",
          isProtected: request.isProtected,
          localContent: request.content,
        });
      }
    },
  });

  const [conflict, setConflict] = useState<SaveConflict | null>(null);

  const resolveConflict = (resolution: "keepMine" | "takeTheirs" | "dismiss", serverVersion?: number) => {
    if (!conflict) return;
    if (resolution === "keepMine" && serverVersion != null) {
      // Re-apply the user's local edits on top of the server's current version.
      // This is an explicit, user-approved overwrite (after seeing the diff).
      save.mutate({
        noteId: conflict.noteId,
        expectedVersion: serverVersion,
        type: conflict.type,
        isProtected: conflict.isProtected,
        content: conflict.localContent,
      });
    } else if (resolution === "takeTheirs") {
      // Discard local edits and adopt the server's current content.
      qc.invalidateQueries({ queryKey: ["note", conflict.noteId] });
      qc.invalidateQueries({ queryKey: ["history"] });
    }
    // "dismiss" keeps the local edits in the editor untouched.
    setConflict(null);
  };

  const saveTitle = useMutation({
    mutationFn: (nextTitle: string) =>
      client.updateNote(selected!, {
        title: nextTitle.trim() || "Untitled note",
        expectedVersion: note.data.version,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["note", selected] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const convertNote = useMutation({
    mutationFn: (type: "text" | "code") =>
      client.updateNote(selected!, { type, expectedVersion: note.data.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["note", selected] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const restoreNote = useMutation({
    mutationFn: (noteId: string) => client.restoreNote(noteId),
    onSuccess: (_restored, noteId) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["history"] });
      onNoteRestored(noteId);
    },
  });

  const purgeTrash = useMutation({
    mutationFn: () => client.purgeTrash(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const clearUnusedAttachments = useMutation({
    mutationFn: () => client.clearUnusedAttachments(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attachments"] });
    },
  });

  const renameNote = useMutation({
    mutationFn: async ({ noteId, nextTitle }: { noteId: string; nextTitle: string }) => {
      const current = await client.getNote(noteId);
      return client.updateNote(noteId, { title: nextTitle, expectedVersion: current.version });
    },
    onSuccess: (_updated, variables) => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["note", variables.noteId] });
      qc.invalidateQueries({ queryKey: ["history"] });
    },
  });

  const refreshTree = () => {
    qc.invalidateQueries({ queryKey: ["tree"] });
    qc.invalidateQueries({ queryKey: ["history"] });
    qc.invalidateQueries({ queryKey: ["archived"] });
  };

  const autoSave = (content: any) => {
    // Bind the write to the note/version which produced this editor update.
    // If the selection changes before the debounce expires, the effect below
    // cancels it instead of writing stale content into a different note.
    if (!selected || !note.data || note.data.id !== selected) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    const settings = readSettings();
    const revisionIntervalMs = durationMs(settings.revisionIntervalMinutes, settings.revisionIntervalUnit);
    const request: ContentSaveRequest = {
      noteId: selected,
      expectedVersion: note.data.version,
      type: note.data.type,
      isProtected: note.data.isProtected,
      content,
    };
    const flush = () => {
      autoSaveTimerRef.current = undefined;
      autoSaveWindowStartRef.current = undefined;
      save.mutate(request);
    };
    const nowTs = Date.now();
    if (autoSaveWindowStartRef.current === undefined) autoSaveWindowStartRef.current = nowTs;
    // While edits keep arriving, flush at most once per snapshot interval so a
    // long, uninterrupted writing session still persists and never spawns a
    // revision on every keystroke. The server's revision throttle collapses
    // the window into a single snapshot as well.
    if (revisionIntervalMs > 0 && nowTs - autoSaveWindowStartRef.current >= revisionIntervalMs) {
      flush();
      return;
    }
    autoSaveTimerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  // A note switch or hook teardown must never leave an old editor's deferred
  // update in flight.
  useEffect(() => () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveWindowStartRef.current = undefined;
  }, [selected]);

  return {
    tree,
    note,
    history,
    archivedNotes,
    attachments,
    archiveNote,
    createNote,
    save,
    saveTitle,
    convertNote,
    restoreNote,
    purgeTrash,
    clearUnusedAttachments,
    renameNote,
    refreshTree,
    autoSave,
    conflict,
    resolveConflict,
  };
}
