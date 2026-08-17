import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../lib/i18n";
import { readSettings, type TimeUnit } from "../features/settings/settingsStore";
import { linesFromContent } from "../components/note/DiffView";

function durationMs(value: number, unit: TimeUnit) {
  const multiplier = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[unit];
  // Settings live in localStorage and can outlast schema changes or be
  // manually corrupted. Never let an invalid revision preference serialize as
  // `null` in a note PATCH request (JSON.stringify(NaN) === "null"), because
  // the API correctly requires revisionIntervalMs to be an integer.
  if (!Number.isFinite(value) || !Number.isFinite(multiplier)) return 0;
  return Math.max(0, Math.floor(value)) * multiplier;
}

type UseNotesOptions = {
  client: YgdriaClient;
  selected?: string;
  selectedTrashed?: boolean;
  settingsOpen: boolean;
  activeTabId?: string;
  editing: boolean;
  locale: Locale;
  dataAccessReady: boolean;
  onNoteCreated: (noteId: string, parentPlacementId?: string | null) => void;
  onNoteRestored: (noteId: string) => void;
};

type ContentSaveRequest = {
  noteId: string;
  expectedVersion: number;
  type?: "text" | "code";
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

/** True when two note contents flatten to identical diff lines. This mirrors
 * the ConflictDialog's "no diff" judgement (empty DiffView hunks) and is used
 * to absorb a 409 silently when only the version diverged while both sides
 * remain textually identical. */
export function isSameDiffContent(a: unknown, b: unknown): boolean {
  const linesA = linesFromContent(a);
  const linesB = linesFromContent(b);
  return linesA.length === linesB.length && linesA.every((line, index) => line === linesB[index]);
}

function sameTags(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = [...(b ?? [])].sort();
  return left.length === right.length && [...left].sort().every((tag, index) => tag === right[index]);
}

export function useNotes({
  client,
  selected,
  selectedTrashed,
  settingsOpen,
  activeTabId,
  editing,
  locale,
  dataAccessReady,
  onNoteCreated,
  onNoteRestored,
}: UseNotesOptions) {
  const qc = useQueryClient();
  // Editor updates only replace this draft while editing. It is written once
  // when the user intentionally exits editing mode.
  const pendingAutoSaveRef = useRef<ContentSaveRequest | undefined>(undefined);
  // Track the latest known version for the selected note. After a successful
  // save the React Query cache may still be stale; using the higher of the
  // cached version and this ref avoids spurious conflict errors.
  const autoSaveVersionRef = useRef<number>(0);
  // Writes to one note must be ordered: a title blur and the final editor
  // flush often happen in the same interaction on mobile. Keep the last
  // server-issued version alongside the per-note promise chain so each write
  // starts with the version produced by its predecessor.
  const noteWriteQueueRef = useRef(new Map<string, Promise<void>>());
  const noteVersionRef = useRef(new Map<string, number>());
  // Mutation callbacks can settle after the user toggles editing. Keep the
  // current mode in a ref so conflict handling uses the mode at completion.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // An editor being unmounted can deliver its final update after the selected
  // note has changed. Keep the live selection separate from that callback's
  // captured selection so the old note is saved immediately.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [deferredConflict, setDeferredConflict] = useState<SaveConflict | null>(null);

  const tree = useQuery({
    queryKey: ["tree"],
    queryFn: () => client.tree(),
    retry: 1,
    enabled: dataAccessReady,
  });

  const note = useQuery({
    queryKey: ["note", selected, selectedTrashed],
    queryFn: () => (selectedTrashed ? client.getTrashedNote(selected!) : client.getNote(selected!)),
    enabled: dataAccessReady && !!selected && !settingsOpen,
  });

  // Keep the version ref in sync with the latest fetched note data.
  useEffect(() => {
    if (note.data && note.data.id === selected) {
      autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, note.data.version);
      noteVersionRef.current.set(
        note.data.id,
        Math.max(noteVersionRef.current.get(note.data.id) ?? 0, note.data.version),
      );
    }
  }, [note.data, selected]);

  // Reset the version ref when switching notes.
  useEffect(() => {
    autoSaveVersionRef.current = 0;
  }, [selected]);

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
    mutationFn: ({
      parentPlacementId,
      type = "text",
    }: {
      parentPlacementId?: string;
      type?: "text" | "code";
    }) => {
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

  const enqueueNoteWrite = <T>(
    noteId: string,
    fallbackVersion: number,
    write: (expectedVersion: number) => Promise<T>,
  ): Promise<T> => {
    const previous = noteWriteQueueRef.current.get(noteId) ?? Promise.resolve();
    const operation = previous
      // A rejected write must not permanently block later user-initiated
      // writes. Its error remains attached to the mutation that created it.
      .catch(() => undefined)
      .then(async () => {
        const expectedVersion = Math.max(fallbackVersion, noteVersionRef.current.get(noteId) ?? 0);
        const updated = await write(expectedVersion);
        const version = (updated as { version?: unknown } | null)?.version;
        if (typeof version === "number") {
          noteVersionRef.current.set(
            noteId,
            Math.max(noteVersionRef.current.get(noteId) ?? 0, version),
          );
          if (noteId === selected)
            autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, version);
        }
        return updated;
      });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    noteWriteQueueRef.current.set(noteId, tail);
    void tail.finally(() => {
      if (noteWriteQueueRef.current.get(noteId) === tail) noteWriteQueueRef.current.delete(noteId);
    });
    return operation;
  };

  const save = useMutation({
    mutationFn: ({
      noteId,
      expectedVersion,
      type,
      isProtected,
      content: contentOrCiphertext,
    }: ContentSaveRequest) => {
      const settings = readSettings();
      const revisionIntervalMs = durationMs(
        settings.revisionIntervalMinutes,
        settings.revisionIntervalUnit,
      );
      if (isProtected && typeof contentOrCiphertext === "string") {
        return enqueueNoteWrite(noteId, expectedVersion, (version) =>
          client.updateNote(noteId, {
            contentCiphertext: contentOrCiphertext,
            expectedVersion: version,
          }),
        );
      }
      if (type === "code" && typeof contentOrCiphertext === "string") {
        return enqueueNoteWrite(noteId, expectedVersion, (version) =>
          client.updateNote(noteId, {
            code: contentOrCiphertext,
            revisionIntervalMs,
            expectedVersion: version,
          }),
        );
      }
      if (type === "code" && contentOrCiphertext && typeof contentOrCiphertext.code === "string") {
        return enqueueNoteWrite(noteId, expectedVersion, (version) =>
          client.updateNote(noteId, {
            code: contentOrCiphertext.code,
            codeLanguage: contentOrCiphertext.codeLanguage,
            tags: contentOrCiphertext.tags,
            revisionIntervalMs,
            expectedVersion: version,
          }),
        );
      }
      if (contentOrCiphertext && typeof contentOrCiphertext === "object" && "tags" in contentOrCiphertext && !("content" in contentOrCiphertext) && !("code" in contentOrCiphertext)) {
        return enqueueNoteWrite(noteId, expectedVersion, (version) =>
          client.updateNote(noteId, {
            tags: contentOrCiphertext.tags,
            expectedVersion: version,
          }),
        );
      }
      return enqueueNoteWrite(noteId, expectedVersion, (version) =>
        client.updateNote(noteId, {
          // NoteContent wraps rich-text editor updates as `{ content, tags }`
          // so tags can be saved atomically with the document. The API's
          // `content` field expects the TipTap document itself, not that
          // wrapper; passing it through produced `content.content` and the
          // server correctly rejected the PATCH as malformed.
          content: contentOrCiphertext?.content ?? contentOrCiphertext,
          tags: contentOrCiphertext?.tags,
          revisionIntervalMs,
          expectedVersion: version,
        }),
      );
    },
    onSuccess: async (updated, request) => {
      const noteQuery = { queryKey: ["note", request.noteId] };
      // A user can return to this note while its pre-save GET is still in
      // flight. Cancel that stale read before publishing the PATCH response;
      // otherwise it can overwrite the newly saved content until the next
      // tab switch triggers another fetch.
      await qc.cancelQueries(noteQuery);
      qc.setQueriesData(noteQuery, (current: any) =>
        current?.id === request.noteId ? updated : current,
      );
      qc.invalidateQueries(noteQuery);
      qc.invalidateQueries({ queryKey: ["history"] });
      // Bump the tracked version so the next autosave won't use a stale
      // expectedVersion from the React Query cache.
      if (updated?.version != null) {
        autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, updated.version);
      }
      const { revisionLimit } = readSettings();
      if (Number.isInteger(revisionLimit) && revisionLimit >= 0)
        void client.clearExcessRevisions(revisionLimit);
    },
    onError: (error, request) => {
      // The note was modified elsewhere (another device via sync, or a second
      // tab) so the optimistic-lock version no longer matches. Surface it as a
      // resolvable conflict instead of silently dropping the user's edits.
      if (!isConflictError(error)) return;
      const nextConflict = {
        noteId: request.noteId,
        type: request.type === "code" ? "code" : "text",
        isProtected: request.isProtected,
        localContent: request.content,
      } satisfies SaveConflict;
      const surface = () => {
        // Do not interrupt an active mobile editing session. The latest failed
        // save is presented once editing ends.
        if (editingRef.current) setDeferredConflict(nextConflict);
        else setConflict((current) => current ?? nextConflict);
      };
      // Protected content is ciphertext here and cannot be compared against the
      // server's view, so keep the explicit dialog for it.
      if (request.isProtected) {
        surface();
        return;
      }
      void (async () => {
        try {
          // Version-only divergence (sync applied another device's save of the
          // same text, a second tab bumped the version, ...): the conflict
          // dialog would show "no diff" and only alarm the user. Absorb it
          // silently and refresh the tracked version instead.
          const serverNote = await client.getNote(request.noteId);
          const raw = request.content as
            | { content?: unknown; code?: string; tags?: string[]; codeLanguage?: string }
            | string
            | undefined;
          const wrapper = raw && typeof raw === "object" ? raw : undefined;
          const localForCompare =
            request.type === "code"
              ? (typeof raw === "string" ? raw : wrapper?.code)
              : (wrapper && "content" in wrapper ? wrapper.content : raw);
          const tagsUnchanged =
            wrapper?.tags === undefined || sameTags(wrapper.tags, serverNote?.tags as string[] | undefined);
          const codeLanguageUnchanged =
            request.type !== "code" ||
            wrapper?.codeLanguage === undefined ||
            wrapper.codeLanguage === serverNote?.codeLanguage;
          if (
            serverNote &&
            typeof serverNote.version === "number" &&
            tagsUnchanged &&
            codeLanguageUnchanged &&
            isSameDiffContent(localForCompare, serverNote.content)
          ) {
            noteVersionRef.current.set(
              request.noteId,
              Math.max(noteVersionRef.current.get(request.noteId) ?? 0, serverNote.version),
            );
            if (request.noteId === selectedRef.current)
              autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, serverNote.version);
            qc.invalidateQueries({ queryKey: ["note", request.noteId] });
            return;
          }
        } catch {
          // The freshness check itself failed; keep the explicit dialog.
        }
        surface();
      })();
    },
  });

  useEffect(() => {
    if (!editing && !conflict && deferredConflict) {
      setConflict(deferredConflict);
      setDeferredConflict(null);
    }
  }, [editing, conflict, deferredConflict]);

  const resolveConflict = (
    resolution: "keepMine" | "takeTheirs" | "dismiss",
    serverVersion?: number,
  ) => {
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
    mutationFn: (nextTitle: string) => {
      const noteId = selected!;
      const expectedVersion = Math.max(
        note.data.version,
        autoSaveVersionRef.current,
        noteVersionRef.current.get(noteId) ?? 0,
      );
      return enqueueNoteWrite(noteId, expectedVersion, (version) =>
        client.updateNote(noteId, {
          title: nextTitle.trim() || "Untitled note",
          expectedVersion: version,
        }),
      );
    },
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["note", selected] });
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["history"] });
      if (updated?.version != null) {
        autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, updated.version);
      }
    },
    onError: (error, nextTitle) => {
      // Title save failures (409 conflict, network error) must not be silent.
      // Surface them so the user knows the title was not persisted.
      if (!isConflictError(error)) return;
      const noteId = selectedRef.current!;
      const surface = () => {
        setConflict({
          noteId,
          type: note.data?.type === "code" ? "code" : "text",
          isProtected: note.data?.isProtected,
          localContent: note.data?.content,
        });
      };
      if (note.data?.isProtected) {
        surface();
        return;
      }
      void (async () => {
        try {
          // The dialog would compare the cached server content with itself
          // here and always show "no diff". When the server content indeed
          // matches, retry the title write on the fresh version instead so
          // the user's edit is not lost to a version-only divergence.
          const serverNote = await client.getNote(noteId);
          if (
            serverNote &&
            typeof serverNote.version === "number" &&
            isSameDiffContent(note.data?.content, serverNote.content)
          ) {
            noteVersionRef.current.set(
              noteId,
              Math.max(noteVersionRef.current.get(noteId) ?? 0, serverNote.version),
            );
            autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, serverNote.version);
            const updated = await client.updateNote(noteId, {
              title: nextTitle.trim() || "Untitled note",
              expectedVersion: serverNote.version,
            });
            const version = (updated as { version?: unknown } | null)?.version;
            if (typeof version === "number") {
              noteVersionRef.current.set(noteId, Math.max(noteVersionRef.current.get(noteId) ?? 0, version));
              autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, version);
            }
            qc.invalidateQueries({ queryKey: ["note", noteId] });
            qc.invalidateQueries({ queryKey: ["tree"] });
            qc.invalidateQueries({ queryKey: ["history"] });
            return;
          }
        } catch {
          // The freshness check or the retry failed; keep the explicit dialog.
        }
        surface();
      })();
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

  // Protection conversion is performed outside the regular save mutation but
  // also increments the server version. Publish its response so the next
  // editor save never uses the pre-conversion version.
  const publishExternalNoteUpdate = async (updated: any) => {
    if (!updated?.id || typeof updated.version !== "number") return;
    const noteId = updated.id as string;
    noteVersionRef.current.set(
      noteId,
      Math.max(noteVersionRef.current.get(noteId) ?? 0, updated.version),
    );
    if (noteId === selectedRef.current)
      autoSaveVersionRef.current = Math.max(autoSaveVersionRef.current, updated.version);
    const noteQuery = { queryKey: ["note", noteId] };
    await qc.cancelQueries(noteQuery);
    qc.setQueriesData(noteQuery, (current: any) =>
      current?.id === noteId ? updated : current,
    );
    qc.invalidateQueries(noteQuery);
  };

  const autoSave = (content: any) => {
    // Bind the draft to the note/version which produced this editor update.
    if (!selected || !note.data || note.data.id !== selected) return;

    // When the selected note changes (e.g. creating a new note while editing),
    // flush the previous note's pending save before this update overwrites it.
    const pending = pendingAutoSaveRef.current;
    if (pending && pending.noteId !== selected) {
      pendingAutoSaveRef.current = undefined;
      save.mutate(pending);
    }

    pendingAutoSaveRef.current = {
      noteId: selected,
      expectedVersion: Math.max(
        note.data.version,
        autoSaveVersionRef.current,
        noteVersionRef.current.get(selected) ?? 0,
      ),
      type: note.data.type,
      isProtected: note.data.isProtected,
      content,
    };
    // An editor update can be delivered while it is unmounting after leaving
    // edit mode or selecting another note. Persist that final old-note update
    // immediately, because the normal effect has already observed the switch.
    if (!editingRef.current || selectedRef.current !== selected) {
      const pendingSave = pendingAutoSaveRef.current;
      pendingAutoSaveRef.current = undefined;
      save.mutate(pendingSave);
    }
  };

  // Flush the pending draft whenever the user exits editing mode or switches
  // to a different note. The write queue serializes a title blur and this
  // final body flush, so no timer (or optimistic guess about network timing)
  // is needed.
  useEffect(() => {
    const pendingSave = pendingAutoSaveRef.current;
    if (!pendingSave) return;
    // Exit from editing mode: always flush.
    // Switch to a different note while editing: flush the old note's draft.
    if (!editing || pendingSave.noteId !== selected) {
      pendingAutoSaveRef.current = undefined;
      save.mutate(pendingSave);
    }
  }, [editing, selected, save]);

  // ── Visibility / page-hide save ──
  // When the app moves to the background or the page is about to be discarded,
  // flush the draft immediately. `visibilitychange` covers app switching on
  // mobile; `pagehide` covers tab close / navigation.
  useEffect(() => {
    const flush = () => {
      const draft = pendingAutoSaveRef.current;
      if (!draft || !editing) return;
      pendingAutoSaveRef.current = undefined;
      // This cannot be awaited during app suspension, but queueing it before
      // the WebView is paused gives the native request a chance to start.
      save.mutate(draft);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [editing, save]);

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
    publishExternalNoteUpdate,
    autoSave,
    conflict,
    resolveConflict,
  };
}
