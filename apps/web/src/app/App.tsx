import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { YgdriaClient } from "@ygdria/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { SYSTEM_ROOT_NOTE_ID } from "@ygdria/shared";
import { create } from "zustand";
import { t, type Locale } from "../lib/i18n";
import { readSettings, SettingsOutline } from "../features/settings/SettingsPage";
import { NoteInspector } from "../features/note/NoteInspector";
import { TreePanel } from "../components/navigation/TreePanel";
import { TreeContextMenu } from "../components/navigation/TreeContextMenu";
import { DeleteNotesDialog } from "../components/navigation/DeleteNotesDialog";
import { TabContextMenu } from "../components/chrome/TabContextMenu";
import { ConfirmationDialog } from "../components/chrome/ConfirmationDialog";
import { PasswordDialog } from "../components/chrome/PasswordDialog";
import { MigrationToServerDialog } from "../components/chrome/MigrationToServerDialog";
import { DeviceAccessGate } from "../components/chrome/DeviceAccessGate";
import { WindowControls } from "../components/chrome/WindowControls";
import { WorkspaceLayout } from "../components/workspace/WorkspaceLayout";
import { WorkspaceContent } from "../components/workspace/WorkspaceContent";
import {
  assertAuthConfigSupported,
  deriveAccessSecret,
  generateSaltB64,
  srpBeginLogin,
  srpDeriveClientSession,
  srpRegister,
  srpVerifyServer,
} from "../lib/client-crypto";
import { ChildNoteMenu } from "../components/note/ChildNoteMenu";
import { RevisionHistoryDialog } from "../components/note/RevisionHistoryDialog";
import { ConflictDialog } from "../components/note/ConflictDialog";
import { appendTiptapDocument, markdownToTiptap } from "@ygdria/editor";
import type {
  ContextMenuState,
  TabMenuState,
  TreePlacement,
  WorkspaceTab,
} from "../types/workspace";
import { useNotes } from "../hooks/useNotes";
import { useNoteTransfer } from "../hooks/useNoteTransfer";
import { useProtectedSession } from "../hooks/useProtectedSession";
import { useSync } from "../hooks/useSync";
import { useWorkspaceSelection } from "../hooks/useWorkspaceSelection";
import { useWorkspaceTabs } from "../hooks/useWorkspaceTabs";
import { useMaintenance } from "../hooks/useMaintenance";
import { saveRemoteCredential } from "../lib/credentialStorage";

// Local development uses Vite's same-origin proxy; deployments can set VITE_API_URL.
const SESSION_DEVICE_TOKEN_KEY = "ygdria.device-token";
const DESKTOP_ONBOARDING_COMPLETE_KEY = "ygdria.desktop-onboarding-complete";
const initialDeviceToken =
  typeof window === "undefined"
    ? undefined
    : (window.sessionStorage.getItem(SESSION_DEVICE_TOKEN_KEY) ?? undefined);

const useUi = create<{
  selected?: string;
  selectedTrashed?: boolean;
  editing: boolean;
  theme: "light" | "dark";
  locale: Locale;
  set: (
    x: Partial<{
      selected: string;
      selectedTrashed: boolean;
      editing: boolean;
      theme: "light" | "dark";
      locale: Locale;
    }>,
  ) => void;
}>((set) => ({
  editing: false,
  theme: "light",
  locale: readSettings().locale,
  set: (x) => set(x),
}));

/** Subset of YgdriaClient needed for attachment transfer in sync. */
type AttachmentTransferClient = Pick<
  YgdriaClient,
  "hasAttachmentByHash" | "downloadAttachmentByHash" | "uploadAttachmentByHash" | "syncNoteContent"
>;

import { RemoteProxyClient } from "./RemoteProxyClient";

export function App({ client }: { client: YgdriaClient }) {
  const { selected, selectedTrashed, editing, locale, set } = useUi();
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [treePanelWidth, setTreePanelWidth] = useState(
    () => Math.min(360, Math.max(180, Math.round(window.innerWidth * 0.18))),
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorPanelWidth, setInspectorPanelWidth] = useState(200);
  const [selectedPlacementIds, setSelectedPlacementIds] = useState<Set<string>>(new Set());
  const [selectedPlacementId, setSelectedPlacementId] = useState<string>();
  const [selectionParentId, setSelectionParentId] = useState<string | null | undefined>();
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | undefined>();
  const [activeEditor, setActiveEditor] = useState<any>(null);
  const handleEditorReady = useCallback((editor: any) => setActiveEditor(editor), []);
  const [markdownView, setMarkdownView] = useState(false);
  const [toastMessage, setToastMessage] = useState<string>();
  const toastTimerRef = useRef<number | undefined>(undefined);
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(undefined);
      toastTimerRef.current = undefined;
    }, 3500);
  }, []);
  const documentScrollRef = useRef<HTMLDivElement>(null);
  const pendingViewScrollRef = useRef<{ top: number; left: number } | null>(null);
  const toggleEditing = useCallback(() => {
    if (selected === SYSTEM_ROOT_NOTE_ID) {
      showToast(t(locale, "rootNoteNotEditable"));
      return;
    }
    // Exit Markdown view when switching between edit and read-only mode
    if (markdownView) {
      setMarkdownView(false);
    }
    const scroll = documentScrollRef.current;
    if (scroll) pendingViewScrollRef.current = { top: scroll.scrollTop, left: scroll.scrollLeft };
    set({ editing: !editing });
  }, [editing, set, selected, locale, showToast, markdownView]);

  const importMarkdown = useCallback(async () => {
    if (!editing) {
      showToast(t(locale, "markdownImportFailed", { reason: t(locale, "read") }));
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        showToast(t(locale, "clipboardEmpty"));
        return;
      }
      const { document, warnings } = markdownToTiptap(text);
      if (activeEditor && !activeEditor.isDestroyed) {
        // Append imported Markdown after the current note content. The editor's
        // update callback will persist the combined document.
        const combinedDocument = appendTiptapDocument(activeEditor.getJSON(), document);
        activeEditor.commands.setContent(combinedDocument);
      } else {
        showToast(t(locale, "markdownImportFailed", { reason: t(locale, "editorUnavailable") }));
        return;
      }
      showToast(t(locale, "markdownImportSuccess"));
      if (warnings.length > 0) {
        showToast(t(locale, "markdownImportWarning"));
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        showToast(t(locale, "clipboardAccessDenied"));
      } else {
        showToast(
          t(locale, "markdownImportFailed", { reason: error instanceof Error ? error.message : t(locale, "markdownParseFailed") }),
        );
      }
    }
  }, [editing, locale, showToast, activeEditor]);

  const toggleMarkdownView = useCallback(() => {
    setMarkdownView((current) => !current);
  }, []);

  useLayoutEffect(() => {
    const position = pendingViewScrollRef.current;
    const scroll = documentScrollRef.current;
    if (!position || !scroll) return;
    const restore = () => {
      scroll.scrollTop = position.top;
      scroll.scrollLeft = position.left;
    };
    // The first restore happens before paint; the second covers layout work
    // performed while TipTap mounts or the static document is reconstructed.
    // Code-note highlighting adds decorations after that frame, so keep the
    // snapshot until one final post-layout restore has run as well.
    restore();
    const frame = requestAnimationFrame(() => {
      restore();
    });
    const settled = window.setTimeout(() => {
      restore();
      pendingViewScrollRef.current = null;
    }, 80);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settled);
    };
  }, [editing]);
  // Reset markdown view when switching notes
  useEffect(() => {
    setMarkdownView(false);
  }, [selected]);
  const [treeClipboard, setTreeClipboard] = useState<{
    placements: TreePlacement[];
    mode: "cut" | "copy";
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [tabMenu, setTabMenu] = useState<TabMenuState>(null);
  const [childNoteMenu, setChildNoteMenu] = useState<{
    placement: TreePlacement;
    x: number;
    y: number;
  } | null>(null);
  const [revisionHistoryOpen, setRevisionHistoryOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<TreePlacement[] | null>(null);
  const [purgeTrashConfirmation, setPurgeTrashConfirmation] = useState(false);
  const [clearUnusedAttachmentsConfirmation, setClearUnusedAttachmentsConfirmation] =
    useState(false);
  const [deviceAccess, setDeviceAccess] = useState<"checking" | "ready" | "initialize" | "login">(
    "checking",
  );
  const [requiresDeviceAuth, setRequiresDeviceAuth] = useState(false);
  const isDesktopApp = Boolean(window.ygdria?.remote);
  const [migrationDialogOpen, setMigrationDialogOpen] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const childNoteMenuRef = useRef<HTMLDivElement>(null);
  const creatingNoteRef = useRef(false);
  const hasWindowControls = Boolean(window.ygdria?.windowControl);

  const workspaceTabs = useWorkspaceTabs({
    onActivate: (tab, nextEditing) => {
      if (tab?.kind === "note") {
        set({ selected: tab.noteId, selectedTrashed: tab.isTrashed, editing: nextEditing });
      } else {
        setSelectedPlacementId(undefined);
        set({ selected: undefined, selectedTrashed: false, editing: false });
      }
    },
  });
  const {
    tabs,
    activeTab,
    activeTabId,
    settingsOpen,
    pinnedTabIds,
    closedTabs,
    activateTab,
    openNote,
    openSettings,
    openSearch,
    openHistory,
    openArchive,
    openAttachments,
    openNewTab,
    closeTab,
    closeTabs,
    togglePin,
    reopenClosedTab,
    openTabInNewWindow,
    clearTabs,
  } = workspaceTabs;

  const queryClient = useQueryClient();

  const {
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
  } = useNotes({
    client,
    selected,
    selectedTrashed,
    settingsOpen,
    activeTabId,
    locale,
    dataAccessReady: deviceAccess === "ready",
    onNoteCreated: (noteId) => {
      openNote(noteId, false, true);
      // The creation response contains a note, not its placement. Read the
      // refreshed tree so a new daily note is visibly selected under its day.
      void client
        .tree()
        .then((placements) => {
          const placement = (placements as TreePlacement[]).find(
            (item) => item.noteId === noteId && !item.isTrashed && !item.isSystem && !item.isTrash,
          );
          if (!placement) return;
          setSelectedPlacementIds(new Set());
          setSelectedPlacementId(placement.placementId);
          setSelectionParentId(placement.parentPlacementId);
          setSelectionAnchorId(placement.placementId);
        })
        .catch((error) => console.error("Unable to select the created note", error));
    },
    onNoteRestored: (noteId) => closeTab(`note:${noteId}:trash`),
  });

  const {
    session,
    protectedSession,
    setProtectedSession,
    decryptedTitles,
    passwordDialog,
    setPasswordDialog,
    handleProtectedSessionToggle,
    handleProtectedSessionTimeoutChange,
    handlePasswordSubmit,
  } = useProtectedSession({
    client,
    requiresDeviceAuth,
    deviceAccess,
    refreshTree,
    setDeviceAccess,
    treeData: tree.data,
    locale,
  });

  const {
    remoteClient,
    setRemoteClient,
    desktopOnboarding,
    setDesktopOnboarding,
    remoteReauthRequired,
    setRemoteReauthRequired,
    remoteReauthInProgressRef,
    pendingSyncServerUrl,
    setPendingSyncServerUrl,
    reauthenticateRemote,
    migrateToEmptyServer,
    syncState,
    syncProgress,
    syncing,
    syncAfterBootstrap,
    setSyncAfterBootstrap,
    syncNow,
  } = useSync({
    client,
    locale,
    refreshTree,
    openSettings,
    deviceAccess,
    session,
    setProtectedSession,
    showToast,
    isDesktopApp,
  });

  useEffect(() => {
    let cancelled = false;
    void client
      .health()
      .then(async (health) => {
        if (cancelled) return;
        setRequiresDeviceAuth(health.requiresDeviceAuth);
        if (!health.requiresDeviceAuth) {
          setDeviceAccess("ready");
          return;
        }
        if (initialDeviceToken) {
          try {
            // sessionStorage survives a page refresh, but a new API client is
            // created for each page load. Restore its bearer token before
            // validating the saved device session.
            client.setDeviceToken(initialDeviceToken);
            await client.currentDevice();
            if (!cancelled) setDeviceAccess("ready");
            return;
          } catch {
            client.setDeviceToken(undefined);
            window.sessionStorage.removeItem(SESSION_DEVICE_TOKEN_KEY);
          }
        }
        if (!cancelled) setDeviceAccess(health.authInitialized ? "login" : "initialize");
      })
      .catch(() => {
        if (!cancelled) setDeviceAccess("login");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const createNewNote = useCallback(
    async (parentPlacementId?: string, type: "text" | "code" = "text") => {
      if (creatingNoteRef.current) return;
      creatingNoteRef.current = true;
      try {
        await createNote.mutateAsync({ parentPlacementId, type });
      } catch (error) {
        // Event handlers intentionally do not await this function.  Keeping the
        // rejection here prevents Electron's renderer from treating a failed
        // rapid create as an unhandled promise rejection (and blanking the app).
        console.error("Unable to create note", error);
      } finally {
        creatingNoteRef.current = false;
      }
    },
    [createNote],
  );

  const openTodayNote = useCallback(async () => {
    try {
      // The shortcut opens the calendar day itself. Creating the first child
      // note is an explicit user action, not a side effect of navigation.
      const note = await client.ensureTodayNote();
      const { data: placements } = await tree.refetch();
      let placementId: string | undefined;
      if (placements) {
        const placement = (placements as TreePlacement[]).find(
          (p) => p.noteId === note.id && !p.isTrashed && !p.isSystem && !p.isTrash,
        );
        if (placement) {
          placementId = placement.placementId;
          setSelectedPlacementIds(new Set());
          setSelectedPlacementId(placement.placementId);
          setSelectionParentId(placement.parentPlacementId);
          setSelectionAnchorId(placement.placementId);
        }
      }
      openNote(note.id, false, true, false, placementId);
    } catch (error) {
      console.error("Unable to open today's calendar day", error);
    }
  }, [client, tree, openNote]);

  const showImportComplete = useCallback((summary: { notes: number; attachments: number; estimatedBytes: number }) => {
    const size = summary.estimatedBytes < 1024 * 1024
      ? `${Math.ceil(summary.estimatedBytes / 1024)} KiB`
      : `${(summary.estimatedBytes / 1024 / 1024).toFixed(1)} MiB`;
    showToast(`${t(locale, "importComplete")} · ${summary.notes} ${locale === "zh-CN" ? "篇笔记" : "notes"} · ${summary.attachments} ${locale === "zh-CN" ? "个附件" : "attachments"} · ${size}`);
  }, [locale, showToast]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const { importInputRef, openImportDialog, exportPlacements, importNotes } = useNoteTransfer({
    client,
    tree: tree.data ?? [],
    locale,
    refreshTree,
    session,
    unlocked: protectedSession.unlocked,
    onImportComplete: showImportComplete,
  });

  const {
    childrenByParent,
    currentPlacement,
    noteBreadCrumb,
    childNotes,
    openChildNote,
    selectTreePlacement,
    pastePlacements,
    treeTitleForTab,
    noteTitleForTab,
  } = useWorkspaceSelection({
    client,
    locale,
    treeData: tree.data,
    selected,
    selectedPlacementId,
    selectedPlacementIds,
    selectionParentId,
    selectionAnchorId,
    activeTabId,
    activeTab,
    settingsOpen,
    decryptedTitles,
    treeClipboard,
    setTreeClipboard,
    setSelectedPlacementIds,
    setSelectedPlacementId,
    setSelectionParentId,
    setSelectionAnchorId,
    setDeleteConfirmation,
    refreshTree,
    openNote,
    tabs,
    noteData: note.data,
  });

  const {
    clearingExcessRevisions,
    revisionCleanupMessage,
    maintainingDatabase,
    databaseMaintenanceMessage,
    databaseMaintenanceMessageTarget,
    testingSyncConnection,
    syncConnectionMessage,
    clearExcessRevisions,
    maintainDatabase,
    testSyncConnection,
  } = useMaintenance({
    client,
    locale,
    deviceAccess,
    isDesktopApp,
  });

  const resizeTreePanel = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = treePanelWidth;
    const onPointerMove = (moveEvent: PointerEvent) => {
      setTreePanelWidth(Math.min(420, Math.max(220, startWidth + moveEvent.clientX - startX)));
    };
    const onPointerUp = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setTabMenu(null);
        setChildNoteMenu(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  // Note content autosaves continuously, so the browser's "save page" prompt
  // on Ctrl/Cmd+S is never useful here. Suppress it to avoid surprising the
  // user mid-edit (native copy/paste/cut and Enter still work everywhere).
  useEffect(() => {
    const preventBrowserSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", preventBrowserSave);
    return () => window.removeEventListener("keydown", preventBrowserSave);
  }, []);

  useLayoutEffect(() => {
    const clampMenu = <T extends { x: number; y: number }>(
      menu: T | null,
      element: HTMLDivElement | null,
      update: (next: T) => void,
    ) => {
      if (!menu || !element) return;
      const menuElement = element.querySelector<HTMLElement>('[role="menu"]') ?? element;
      const { width, height } = menuElement.getBoundingClientRect();
      const x = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
      const y = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8));
      if (x !== menu.x || y !== menu.y) update({ ...menu, x, y });
    };
    clampMenu(contextMenu, contextMenuRef.current, setContextMenu);
    clampMenu(tabMenu, tabMenuRef.current, setTabMenu);
    clampMenu(childNoteMenu, childNoteMenuRef.current, setChildNoteMenu);
  }, [contextMenu, tabMenu, childNoteMenu]);

  useEffect(() => {
    const closeForAnotherMenu = () => {
      setContextMenu(null);
      setTabMenu(null);
      setChildNoteMenu(null);
    };
    window.addEventListener("ygdria:editor-context-menu-open", closeForAnotherMenu);
    return () => window.removeEventListener("ygdria:editor-context-menu-open", closeForAnotherMenu);
  }, []);

  useEffect(() => {
    if (!childNoteMenu) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!childNoteMenuRef.current?.contains(event.target as Node)) setChildNoteMenu(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [childNoteMenu]);

  useEffect(() => {
    if (!window.ygdria?.zoom) return;
    const zoomWithWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      void window.ygdria?.zoom?.(event.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => window.removeEventListener("wheel", zoomWithWheel);
  }, []);

  const resizeInspectorPanel = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorPanelWidth;
    const onPointerMove = (moveEvent: PointerEvent) => {
      setInspectorPanelWidth(Math.min(420, Math.max(200, startWidth + startX - moveEvent.clientX)));
    };
    const onPointerUp = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  if (deviceAccess === "checking" || desktopOnboarding === "checking") {
    return (
      <main className="device-access-shell">
        <div className="empty">{t(locale, "loading")}</div>
      </main>
    );
  }
  const desktopMigration = desktopOnboarding === "required";
  if (desktopMigration || deviceAccess === "initialize" || deviceAccess === "login") {
    return (
      <DeviceAccessGate
        initializing={desktopMigration || deviceAccess === "initialize"}
        remoteRequiresHttps={desktopMigration}
        onSubmit={async (password, label) => {
          if (desktopMigration) {
            // Desktop-only "create" path: establish the same local master
            // password used by a future standalone-server migration.
            await session.setup(password);
            await client.setupProtectedSession(session.salt!, session.verifier!, session.timeoutMs);
            window.localStorage.setItem(DESKTOP_ONBOARDING_COMPLETE_KEY, "true");
            setProtectedSession((current) => ({ ...current, configured: true, unlocked: true }));
            setDesktopOnboarding("complete");
          } else if (deviceAccess === "initialize") {
            // First-time setup: derive BOTH the file key and the accessSecret
            // from the SAME master password, run SRP registration, and submit
            // them together so the server writes them in one atomic transaction.
            // The protected session is left unlocked (key in memory) so the
            // user can immediately protect notes without a separate setup step.
            const accessSalt = generateSaltB64();
            const accessSecret = await deriveAccessSecret(password, accessSalt);
            const registration = srpRegister(accessSecret);
            await session.setup(password);
            const credential = await client.initializeMasterPassword(
              accessSalt,
              registration.srpSalt,
              registration.verifier,
              session.salt!,
              session.verifier!,
              label,
            );
            client.setDeviceToken(credential.deviceToken);
            window.sessionStorage.setItem(SESSION_DEVICE_TOKEN_KEY, credential.deviceToken);
            setProtectedSession((current) => ({ ...current, configured: true, unlocked: true }));
          } else {
            // Login: PAKE challenge-response. No password or static hash is
            // ever sent; the server proof is verified for mutual authentication.
            const config = await client.authConfig();
            assertAuthConfigSupported(config);
            if (!config.initialized || !config.accessSalt || !config.srpSalt)
              throw new Error("服务尚未初始化主密码，请刷新后重试。");
            const accessSecret = await deriveAccessSecret(password, config.accessSalt);
            const clientEphemeral = srpBeginLogin();
            const challenge = await client.srpLoginChallenge(clientEphemeral.public);
            const clientSession = srpDeriveClientSession(
              clientEphemeral,
              challenge.serverPublicEphemeral,
              challenge.srpSalt,
              accessSecret,
            );
            const result = await client.srpLoginVerify(
              challenge.challengeId,
              clientEphemeral.public,
              clientSession.proof,
              label,
            );
            // Verify the server's proof; a forged/MITM response fails here.
            srpVerifyServer(clientEphemeral, clientSession, result.serverSessionProof);
            client.setDeviceToken(result.deviceToken);
            window.sessionStorage.setItem(SESSION_DEVICE_TOKEN_KEY, result.deviceToken);
          }
          setDeviceAccess("ready");
          refreshTree();
        }}
        onConnectExisting={
          desktopMigration || deviceAccess === "initialize"
            ? async (serverUrl, password, label) => {
                // Desktop: main process holds the token; renderer uses IPC proxy.
                // Browser: direct YgdriaClient with token in sessionStorage.
                if (isDesktopApp) await window.ygdria!.remote!.configure(serverUrl);
                const remote = isDesktopApp
                  ? new RemoteProxyClient(serverUrl)
                  : new YgdriaClient(serverUrl);
                if (desktopMigration) {
                  // A first-run desktop client attaches to an existing remote
                  // knowledge base, then pulls it into its empty local store.
                  const remoteConfig = await remote.authConfig();
                  assertAuthConfigSupported(remoteConfig);
                  if (
                    !remoteConfig.initialized ||
                    !remoteConfig.accessSalt ||
                    !remoteConfig.srpSalt
                  )
                    throw new Error("目标服务端尚未初始化；请先在目标服务端创建知识库。");
                  const accessSecret = await deriveAccessSecret(password, remoteConfig.accessSalt);
                  const clientEphemeral = srpBeginLogin();
                  const challenge = await remote.srpLoginChallenge(clientEphemeral.public);
                  const clientSession = srpDeriveClientSession(
                    clientEphemeral,
                    challenge.serverPublicEphemeral,
                    challenge.srpSalt,
                    accessSecret,
                  );
                  const remoteCredential = await remote.srpLoginVerify(
                    challenge.challengeId,
                    clientEphemeral.public,
                    clientSession.proof,
                    label,
                  );
                  srpVerifyServer(
                    clientEphemeral,
                    clientSession,
                    remoteCredential.serverSessionProof,
                  );
                  if (remoteCredential.deviceToken) {
                    (remote as YgdriaClient).setDeviceToken(remoteCredential.deviceToken);
                    void saveRemoteCredential({
                      serverUrl,
                      deviceToken: remoteCredential.deviceToken,
                    });
                  }
                  await session.setup(password);
                  await client.setupProtectedSession(
                    session.salt!,
                    session.verifier!,
                    session.timeoutMs,
                  );
                  window.localStorage.setItem(DESKTOP_ONBOARDING_COMPLETE_KEY, "true");
                  setRemoteClient(remote);
                  setProtectedSession((current) => ({
                    ...current,
                    configured: true,
                    unlocked: true,
                  }));
                  setDesktopOnboarding("complete");
                  setSyncAfterBootstrap(true);
                  return;
                }
                const config = await remote.authConfig();
                assertAuthConfigSupported(config);
                if (!config.initialized || !config.accessSalt || !config.srpSalt)
                  throw new Error("目标服务端尚未初始化；请先在目标服务端创建知识库。");
                const accessSecret = await deriveAccessSecret(password, config.accessSalt);
                const clientEphemeral = srpBeginLogin();
                const challenge = await remote.srpLoginChallenge(clientEphemeral.public);
                const clientSession = srpDeriveClientSession(
                  clientEphemeral,
                  challenge.serverPublicEphemeral,
                  challenge.srpSalt,
                  accessSecret,
                );
                const remoteCredential = await remote.srpLoginVerify(
                  challenge.challengeId,
                  clientEphemeral.public,
                  clientSession.proof,
                  label,
                );
                srpVerifyServer(
                  clientEphemeral,
                  clientSession,
                  remoteCredential.serverSessionProof,
                );
                if (remoteCredential.deviceToken) {
                  (remote as YgdriaClient).setDeviceToken(remoteCredential.deviceToken);
                }

                const localAccessSalt = generateSaltB64();
                const localAccessSecret = await deriveAccessSecret(password, localAccessSalt);
                const registration = srpRegister(localAccessSecret);
                await session.setup(password);
                const localCredential = await client.initializeMasterPassword(
                  localAccessSalt,
                  registration.srpSalt,
                  registration.verifier,
                  session.salt!,
                  session.verifier!,
                  label,
                );
                client.setDeviceToken(localCredential.deviceToken);
                window.sessionStorage.setItem(
                  SESSION_DEVICE_TOKEN_KEY,
                  localCredential.deviceToken,
                );
                // Desktop: main process already holds the remote token.
                // Browser: persist remote credential in sessionStorage; native
                // apps use @capacitor/preferences via saveRemoteCredential.
                if (!isDesktopApp && remoteCredential.deviceToken) {
                  void saveRemoteCredential({
                    serverUrl,
                    deviceToken: remoteCredential.deviceToken,
                  });
                }
                setRemoteClient(remote);
                setProtectedSession((current) => ({
                  ...current,
                  configured: true,
                  unlocked: true,
                }));
                setSyncAfterBootstrap(true);
                setDeviceAccess("ready");
                refreshTree();
              }
            : undefined
        }
        onCheckClientMigration={
          !desktopMigration && deviceAccess === "initialize"
            ? async () => {
                const health = await client.health();
                if (!health.authInitialized)
                  throw new Error("尚未检测到客户端迁移。请在已有桌面客户端完成迁移后再试。");
                setDeviceAccess("login");
              }
            : undefined
        }
      />
    );
  }

  const showInspector = settingsOpen || Boolean(note.data);

  return (
    <>
      <WorkspaceLayout
        treeCollapsed={treeCollapsed}
        showInspector={showInspector}
        inspectorCollapsed={inspectorCollapsed}
        hasWindowControls={hasWindowControls}
        treePanelWidth={treePanelWidth}
        inspectorPanelWidth={inspectorPanelWidth}
        importInputRef={importInputRef}
        importAccept=".zip,.json,.md,.markdown,application/zip,text/markdown,application/json"
        onImport={(event) => {
          void importNotes(event).catch((error) => {
            event.target.value = "";
            const reason = error instanceof Error ? error.message : String(error);
            console.error("Unable to import notes", error);
            showToast(t(locale, "importFailed", { reason }));
          });
        }}
        toastMessage={toastMessage}
        onDismissContextMenus={() => {
          setContextMenu(null);
          setTabMenu(null);
        }}
      >
        <TreePanel
          client={client}
          locale={locale}
          tree={tree.data ?? []}
          tabs={tabs}
          selected={selected}
          selectedPlacementId={selectedPlacementId}
          selectedPlacementIds={selectedPlacementIds}
          selectionParentId={selectionParentId}
          selectionAnchorId={selectionAnchorId}
          treeClipboard={treeClipboard}
          activeTabId={activeTabId}
          settingsOpen={settingsOpen}
          collapsed={treeCollapsed}
          panelWidth={treePanelWidth}
          creatingNote={createNote.isPending}
          onCreateNote={(parentId, type) => void createNewNote(parentId, type)}
          onSelectPlacement={selectTreePlacement}
          onToggleExpand={() => {}}
          onContextMenu={(placement, x, y) => {
            setTabMenu(null);
            setContextMenu({ placement, x, y });
          }}
          onSetClipboard={setTreeClipboard}
          onMovePlacement={(placementId, parentPlacementId, position) => {
            void client.movePlacement(placementId, parentPlacementId, position).then(refreshTree);
          }}
          onResizePanel={resizeTreePanel}
          onToggleCollapse={() => setTreeCollapsed((collapsed) => !collapsed)}
          onOpenHistory={openHistory}
          onCloseHistory={() => closeTab("history")}
          onOpenSettings={openSettings}
          onOpenSearch={openSearch}
          onCloseSearch={() => closeTab("search")}
          onCloseSettings={() => closeTab("settings")}
          onOpenArchive={openArchive}
          onOpenAttachments={openAttachments}
          onCloseAttachments={() => closeTab("attachments")}
          protectedSession={protectedSession}
          onProtectedSessionToggle={handleProtectedSessionToggle}
          onOpenTodayNote={openTodayNote}
          syncing={syncing}
          syncState={syncState}
          syncProgress={syncProgress}
          onSync={syncNow}
          onClearTabs={clearTabs}
          refreshTree={refreshTree}
          importInputRef={importInputRef}
          openImportDialog={openImportDialog}
          exportPlacements={exportPlacements}
          importNotes={importNotes}
          decryptedTitles={decryptedTitles}
        />
        {showInspector && !inspectorCollapsed && (
          <div
            className="inspector-resizer"
            role="separator"
            aria-label="Resize note information panel"
            aria-orientation="vertical"
            onPointerDown={resizeInspectorPanel}
          />
        )}
        <WorkspaceContent
          tabs={tabs}
          activeTabId={activeTabId}
          activeTab={activeTab}
          pinnedTabIds={pinnedTabIds}
          noteTitleForTab={noteTitleForTab}
          locale={locale}
          activateTab={activateTab}
          closeTab={closeTab}
          openNewTab={openNewTab}
          onTabContextMenu={(tabId, x, y) => {
            setContextMenu(null);
            setTabMenu({ tabId, x, y });
          }}
          noteBreadCrumb={noteBreadCrumb}
          selectedTrashed={Boolean(selectedTrashed)}
          noteData={note.data}
          restoreNote={restoreNote}
          showInspector={showInspector}
          inspectorCollapsed={inspectorCollapsed}
          onToggleInspector={() => setInspectorCollapsed((collapsed) => !collapsed)}
          onToggleTree={() => setTreeCollapsed((collapsed) => !collapsed)}
          toggleMarkdownView={toggleMarkdownView}
          markdownView={markdownView}
          convertNote={convertNote}
          onViewRevisionHistory={() => setRevisionHistoryOpen(true)}
          activeEditor={activeEditor}
          editing={editing}
          onToggleEditing={toggleEditing}
          importMarkdown={importMarkdown}
          client={client}
          openNote={openNote}
          archivedNotes={archivedNotes}
          treeData={tree.data}
          archiveNote={archiveNote}
          history={history}
          attachments={attachments}
          purgeTrash={purgeTrash}
          setPurgeTrashConfirmation={setPurgeTrashConfirmation}
          settingsOpen={settingsOpen}
          onLocaleChange={(nextLocale) => set({ locale: nextLocale })}
          clearUnusedAttachments={clearUnusedAttachments}
          clearUnusedAttachmentsConfirmation={clearUnusedAttachmentsConfirmation}
          setClearUnusedAttachmentsConfirmation={setClearUnusedAttachmentsConfirmation}
          clearingExcessRevisions={clearingExcessRevisions}
          revisionCleanupMessage={revisionCleanupMessage}
          onClearExcessRevisions={clearExcessRevisions}
          maintainingDatabase={maintainingDatabase}
          databaseMaintenanceMessage={databaseMaintenanceMessage}
          databaseMaintenanceMessageTarget={databaseMaintenanceMessageTarget}
          protectedSessionTimeoutMinutes={Math.floor(protectedSession.timeoutMs / 60_000)}
          canChangeProtectedPassword={protectedSession.configured}
          onChangeProtectedPassword={() => setPasswordDialog("change")}
          testingSyncConnection={testingSyncConnection}
          syncConnectionMessage={syncConnectionMessage}
          onTestSyncConnection={testSyncConnection}
          canMigrateToEmptyServer={isDesktopApp && deviceAccess === "ready"}
          onMigrateToEmptyServer={() => setMigrationDialogOpen(true)}
          canOpenFrontendConsole={Boolean(window.ygdria?.openDevTools)}
          onOpenFrontendConsole={() => { void window.ygdria?.openDevTools?.(); }}
          onProtectedSessionTimeoutChange={handleProtectedSessionTimeoutChange}
          onMaintainDatabase={maintainDatabase}
          noteIsLoading={note.isLoading}
          childNotes={childNotes}
          childrenByParent={childrenByParent}
          session={session}
          autoSave={autoSave}
          saveTitle={saveTitle}
          openChildNote={openChildNote}
          onChildMore={(child, event) => {
            const { right, bottom } = event.currentTarget.getBoundingClientRect();
            setContextMenu(null);
            setTabMenu(null);
            setChildNoteMenu({ placement: child, x: right, y: bottom });
          }}
          onUnarchive={() => note.data && archiveNote.mutate({ noteId: note.data.id, archived: false })}
          onEditorReady={handleEditorReady}
          documentScrollRef={documentScrollRef}
          createNote={createNote}
          createNewNote={createNewNote}
          decryptedTitles={decryptedTitles}
        />
        {showInspector &&
          !inspectorCollapsed &&
          (settingsOpen ? (
            <SettingsOutline locale={locale} />
          ) : (
            note.data && (
              <NoteInspector
                // Do not let the inspector issue a size request until the
                // tree placement and loaded note describe the same entity.
                // During a tab/note switch these two queries may settle in a
                // different render, which previously showed a transient size
                // from the previous placement.
                key={`${note.data.id}:${currentPlacement?.placementId ?? "pending"}`}
                note={note.data}
                placementId={
                  currentPlacement?.noteId === note.data.id
                    ? currentPlacement?.placementId
                    : undefined
                }
                client={client}
                locale={locale}
                editing={editing}
                openNote={openNote}
              />
            )
          ))}
        {hasWindowControls && <WindowControls />}
        {contextMenu && (
          <div ref={contextMenuRef} className="context-menu-layer">
            <TreeContextMenu
              menu={contextMenu}
              client={client}
              tree={tree.data ?? []}
              selectedPlacementId={selectedPlacementId}
              selectedPlacementIds={selectedPlacementIds}
              treeClipboard={treeClipboard}
              locale={locale}
              onClose={() => setContextMenu(null)}
              onCreateChild={(parentId, type) => void createNewNote(parentId, type)}
              onRename={(noteId, nextTitle) => renameNote.mutate({ noteId, nextTitle })}
              onArchive={(noteId, archived) => archiveNote.mutate({ noteId, archived })}
              onSetClipboard={setTreeClipboard}
              onDelete={setDeleteConfirmation}
              onMoveTo={(target, placements) => {
                const destination = window.prompt(t(locale, "movePrompt"));
                const parent = (tree.data ?? []).find(
                  (item) => item.placementId === destination || item.title === destination,
                );
                if (parent)
                  void Promise.all(
                    placements.map((item, index) =>
                      client.movePlacement(item.placementId, parent.placementId, index),
                    ),
                  ).then(refreshTree);
              }}
              onPaste={pastePlacements}
              onExport={exportPlacements}
              onImport={openImportDialog}
            />
          </div>
        )}
        {tabMenu && (
          <div ref={tabMenuRef} className="context-menu-layer">
            <TabContextMenu
              menu={tabMenu}
              tabs={tabs}
              pinnedTabIds={pinnedTabIds}
              closedTabs={closedTabs}
              locale={locale}
              hasWindowControls={hasWindowControls}
              onClose={() => setTabMenu(null)}
              onTogglePin={togglePin}
              onCloseTab={closeTab}
              onCloseTabs={closeTabs}
              onReopenClosedTab={reopenClosedTab}
              onOpenInNewWindow={openTabInNewWindow}
            />
          </div>
        )}
        {childNoteMenu && (
          <div ref={childNoteMenuRef} className="context-menu-layer">
            <ChildNoteMenu
              menu={childNoteMenu}
              locale={locale}
              onClose={() => setChildNoteMenu(null)}
              onOpenInNewTab={(placement) => openChildNote(placement, false, true)}
              onQuickEdit={(placement) => openChildNote(placement, true)}
              onOpenInNewWindow={openTabInNewWindow}
            />
          </div>
        )}
        {deleteConfirmation && (
          <DeleteNotesDialog
            placements={deleteConfirmation}
            locale={locale}
            onCancel={() => setDeleteConfirmation(null)}
            onConfirm={() => {
              const placements = deleteConfirmation;
              setDeleteConfirmation(null);
              void Promise.all(placements.map((item) => client.deletePlacement(item.placementId)))
                .then(() => {
                  if (placements.some((item) => item.placementId === selectedPlacementId))
                    setSelectedPlacementId(undefined);
                  setSelectedPlacementIds(new Set());
                  refreshTree();
                })
                .catch((error) => console.error("Unable to delete notes", error));
            }}
          />
        )}
        {purgeTrashConfirmation && (
          <ConfirmationDialog
            title={t(locale, "purgeTrash")}
            message={t(locale, "purgeTrashConfirm")}
            cancelLabel={t(locale, "cancel")}
            confirmLabel={t(locale, "purgeTrash")}
            onCancel={() => setPurgeTrashConfirmation(false)}
            onConfirm={() => {
              setPurgeTrashConfirmation(false);
              purgeTrash.mutate();
            }}
          />
        )}
        {clearUnusedAttachmentsConfirmation && (
          <ConfirmationDialog
            title={t(locale, "clearUnusedAttachments")}
            message={t(locale, "clearUnusedAttachmentsConfirm")}
            cancelLabel={t(locale, "cancel")}
            confirmLabel={t(locale, "clearNow")}
            onCancel={() => setClearUnusedAttachmentsConfirmation(false)}
            onConfirm={() => {
              setClearUnusedAttachmentsConfirmation(false);
              clearUnusedAttachments.mutate();
            }}
          />
        )}
        {revisionHistoryOpen && note.data && (
          <RevisionHistoryDialog
            client={client}
            locale={locale}
            note={note.data}
            queryClient={queryClient}
            onClose={() => setRevisionHistoryOpen(false)}
          />
        )}
        {conflict && (
          <ConflictDialog
            client={client}
            locale={locale}
            conflict={conflict}
            onResolve={resolveConflict}
            onClose={() => resolveConflict("dismiss")}
          />
        )}
        {remoteReauthRequired && !passwordDialog && (
          <PasswordDialog
            mode="reauth"
            onCancel={() => {
              remoteReauthInProgressRef.current = false;
              setRemoteReauthRequired(false);
            }}
            onSubmit={reauthenticateRemote}
          />
        )}
        {passwordDialog && (
          <PasswordDialog
            mode={passwordDialog}
            onCancel={() => setPasswordDialog(null)}
            onSubmit={handlePasswordSubmit}
          />
        )}
        {migrationDialogOpen && (
          <MigrationToServerDialog
            onCancel={() => setMigrationDialogOpen(false)}
            onSubmit={migrateToEmptyServer}
          />
        )}
        {!treeCollapsed && (
          <div
            className="tree-drawer-scrim"
            aria-hidden="true"
            onClick={() => setTreeCollapsed(true)}
          />
        )}
      </WorkspaceLayout>
    </>
  );
}
