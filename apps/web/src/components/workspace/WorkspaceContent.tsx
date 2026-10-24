import React, { Suspense, lazy, useCallback, type RefObject } from "react";
import { Capacitor } from "@capacitor/core";
import type { YgdriaClient } from "@ygdria/api-client";
import type { Locale } from "../../lib/i18n";
import type { TreePlacement, WorkspaceTab } from "../../types/workspace";
import type { BreadcrumbSegment } from "../chrome/Toolbar";
import { TabBar } from "../chrome/TabBar";
import { Toolbar } from "../chrome/Toolbar";
import { EditorToolbar } from "@ygdria/editor";
import { NewTabSearch } from "../../features/workspace/NewTabSearch";
import { NoteContent } from "../../features/note/NoteContent";
import type { NoteContentData } from "../../features/note/NoteContent";
import type { ProtectedClientSession } from "../../lib/client-crypto";

// Feature pages are code-split: they are large, rarely on the critical path,
// and mobile clients pay for every byte over the network.
const SearchPage = lazy(() =>
  import("../../features/workspace/SearchPage").then((m) => ({ default: m.SearchPage })),
);
const ArchivedNotesPage = lazy(() =>
  import("../../features/workspace/pages").then((m) => ({ default: m.ArchivedNotesPage })),
);
const RecentHistory = lazy(() =>
  import("../../features/workspace/pages").then((m) => ({ default: m.RecentHistory })),
);
const AttachmentsView = lazy(() =>
  import("../../features/workspace/AttachmentsView").then((m) => ({ default: m.AttachmentsView })),
);
const GraphView = lazy(() =>
  import("../graph/GraphView").then((m) => ({ default: m.GraphView })),
);
const SettingsPage = lazy(() =>
  import("../../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

export interface WorkspaceContentProps {
  // Tab management
  tabs: WorkspaceTab[];
  activeTabId: string | undefined;
  activeTab: WorkspaceTab | undefined;
  pinnedTabIds: Set<string>;
  noteTitleForTab: (tab: WorkspaceTab) => string | undefined;
  locale: Locale;
  activateTab: (tab: WorkspaceTab) => void;
  closeTab: (tabId: string) => void;
  openNewTab: () => void;
  openSearch: (options?: { replaceActiveNewTab?: boolean }) => void;
  onTabContextMenu: (tabId: string, x: number, y: number) => void;
  onReorder: (dragId: string, dropId: string) => void;
  onTogglePin?: (tabId: string) => void;

  // Toolbar
  noteBreadCrumb: BreadcrumbSegment[];
  selectedTrashed: boolean;
  noteData: NoteContentData | undefined;
  restoreNote: { isPending: boolean; mutate: (noteId: string) => void };
  showInspector: boolean;
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
  onToggleTree?: () => void;
  toggleMarkdownView?: () => void;
  markdownView: boolean;
  protectedSession?: { configured: boolean; unlocked: boolean };
  onProtectedSessionToggle?: () => void;
  readingMode?: boolean;
  onToggleReadingMode?: () => void;
  convertNote: { mutate: (type: "text" | "code") => void };
  onViewRevisionHistory: () => void;

  // Editor toolbar
  activeEditor: any;
  editing: boolean;
  onToggleEditing: () => void;
  importMarkdown?: () => void;

  // Search
  client: YgdriaClient;
  openNote: (noteId: string, isTrashed?: boolean, editing?: boolean, openInNewTab?: boolean, placementId?: string) => void;

  // Archive
  archivedNotes: { data?: Array<{ id: string; title: string; archivedAt: number; updatedAt: string }>; isLoading: boolean };
  treeData: TreePlacement[] | undefined;
  archiveNote: { mutate: (params: { noteId: string; archived: boolean }) => void };

  // History
  history: { data?: Array<{ id: string; title: string; path: string[]; updatedAt: string; isTrashed: boolean }>; isLoading: boolean };
  attachments: {
    data?: { attachments: import("../../features/workspace/AttachmentsView").AttachmentItem[]; unusedCount: number };
    isLoading: boolean;
  };
  purgeTrash: { isPending: boolean; mutate: () => void };
  setPurgeTrashConfirmation: (value: boolean) => void;

  // Settings
  settingsOpen: boolean;
  onLocaleChange: (nextLocale: Locale) => void;
  clearUnusedAttachments: { isPending: boolean; mutate: () => void };
  setClearUnusedAttachmentsConfirmation: (value: boolean) => void;
  clearingExcessRevisions: boolean;
  revisionCleanupMessage: string | undefined;
  onClearExcessRevisions: (limit: number) => void;
  maintainingDatabase: boolean;
  databaseMaintenanceMessage: string | undefined;
  databaseMaintenanceMessageTarget: "compact" | "fts";
  protectedSessionTimeoutMinutes: number;
  canChangeProtectedPassword: boolean;
  onChangeProtectedPassword: () => void;
  testingSyncConnection: boolean;
  syncConnectionMessage: string | undefined;
  onTestSyncConnection: (serverUrl: string, timeoutSeconds: number) => void;
  canMigrateToEmptyServer: boolean;
  onMigrateToEmptyServer: () => void;
  canOpenFrontendConsole: boolean;
  syncRunsAutomatically?: boolean;
  canEditSyncServerUrl?: boolean;
  /** Desktop only: remote URL tracked by the main process, shown read-only. */
  syncServerDisplayUrl?: string | null;
  etapiAccessAvailable?: boolean;
  onOpenFrontendConsole: () => void;
  onProtectedSessionTimeoutChange: (minutes: number) => void;
  onMaintainDatabase: (rebuildFts?: boolean) => void;

  // Note content
  noteIsLoading: boolean;
  childNotes: TreePlacement[];
  childrenByParent: Map<string | null, TreePlacement[]>;
  session: ProtectedClientSession;
  autoSave: (content: unknown) => void;
  saveTitle: { mutate: (nextTitle: string) => void };
  openChildNote: (placement: TreePlacement, nextEditing?: boolean, openInNewTab?: boolean) => void;
  onChildMore: (child: TreePlacement, event: React.MouseEvent<HTMLElement>) => void;
  onUnarchive: () => void;
  onEditorReady: (editor: any) => void;
  documentScrollRef: RefObject<HTMLDivElement | null>;
  onUploadError?: (message: string) => void;

  // Empty / create
  createNote: { isPending: boolean };
  createNewNote: () => Promise<void>;
  decryptedTitles: Map<string, string>;
}

export function WorkspaceContent({
  tabs,
  activeTabId,
  activeTab,
  pinnedTabIds,
  noteTitleForTab,
  locale,
  activateTab,
  closeTab,
  openNewTab,
  openSearch,
  onTabContextMenu,
  onReorder,
  onTogglePin,
  noteBreadCrumb,
  selectedTrashed,
  noteData,
  restoreNote,
  showInspector,
  inspectorCollapsed,
  onToggleInspector,
  onToggleTree,
  toggleMarkdownView,
  markdownView,
  protectedSession,
  onProtectedSessionToggle,
  readingMode,
  onToggleReadingMode,
  convertNote,
  onViewRevisionHistory,
  activeEditor,
  editing,
  onToggleEditing,
  importMarkdown,
  client,
  openNote,
  archivedNotes,
  treeData,
  archiveNote,
  history,
  attachments,
  purgeTrash,
  setPurgeTrashConfirmation,
  settingsOpen,
  onLocaleChange,
  clearUnusedAttachments,
  setClearUnusedAttachmentsConfirmation,
  clearingExcessRevisions,
  revisionCleanupMessage,
  onClearExcessRevisions,
  maintainingDatabase,
  databaseMaintenanceMessage,
  databaseMaintenanceMessageTarget,
  protectedSessionTimeoutMinutes,
  canChangeProtectedPassword,
  onChangeProtectedPassword,
  testingSyncConnection,
  syncConnectionMessage,
  onTestSyncConnection,
  canMigrateToEmptyServer,
  onMigrateToEmptyServer,
  canOpenFrontendConsole,
  syncRunsAutomatically,
  canEditSyncServerUrl,
  syncServerDisplayUrl,
  etapiAccessAvailable,
  onOpenFrontendConsole,
  onProtectedSessionTimeoutChange,
  onMaintainDatabase,
  noteIsLoading,
  childNotes,
  childrenByParent,
  session,
  autoSave,
  saveTitle,
  openChildNote,
  onChildMore,
  onUnarchive,
  onEditorReady,
  documentScrollRef,
  onUploadError,
  createNote,
  createNewNote,
  decryptedTitles,
}: WorkspaceContentProps) {
  const [searchInitialTag, setSearchInitialTag] = React.useState<string | undefined>();
  // Toolbar image insertion: upload through the by-hash endpoint so images
  // stay attachments instead of inline base64 blobs. Camera capture reuses
  // the same path on the native shell; protected notes never accept inserts.
  const toolbarUploadImage = useCallback(
    async (file: File) => {
      if (!noteData || noteData.isProtected) throw new Error("no target note");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const hash = `sha256:${Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("")}`;
      const result = await client.uploadAttachmentByHash(hash, noteData.id, file.name, file);
      return result.url;
    },
    [client, noteData],
  );
  const toolbarCaptureImage = useCallback(async (): Promise<File | null> => {
    if (!Capacitor.isNativePlatform()) return null;
    const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      quality: 85,
    });
    if (!photo.webPath) return null;
    const response = await fetch(photo.webPath);
    const blob = await response.blob();
    return new File([blob], `photo-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
  }, []);

  return (
    <section className="content">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        pinnedTabIds={pinnedTabIds}
        noteTitleForTab={noteTitleForTab}
        locale={locale}
        onActivate={activateTab}
        onClose={closeTab}
        onNewTab={openNewTab}
        onContextMenu={onTabContextMenu}
        onReorder={onReorder}
        onTogglePin={onTogglePin}
      />
      <Toolbar
        breadcrumb={noteBreadCrumb}
        isTrashed={selectedTrashed}
        hasNote={Boolean(noteData)}
        locale={locale}
        onNavigateHome={openNewTab}
        onNavigateNote={(noteId) => openNote(noteId, false, false)}
        onRestore={() => noteData && restoreNote.mutate(noteData.id)}
        isRestoring={restoreNote.isPending}
        showInspector={showInspector}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={onToggleInspector}
        onToggleTree={onToggleTree}
        noteType={noteData?.type}
        canConvertNote={Boolean(
          noteData && !selectedTrashed && !noteData.isProtected,
        )}
        onConvertNote={() =>
          noteData && convertNote.mutate(noteData.type === "code" ? "text" : "code")
        }
        canViewRevisionHistory={Boolean(
          noteData && !selectedTrashed && !noteData.isProtected,
        )}
        onViewRevisionHistory={onViewRevisionHistory}
        onToggleMarkdownView={
          noteData?.type === "text" && !noteData.isProtected && !selectedTrashed && editing ? toggleMarkdownView : undefined
        }
        markdownView={markdownView}
        protectedSession={protectedSession}
        onProtectedSessionToggle={onProtectedSessionToggle}
        readingMode={readingMode}
        onToggleReadingMode={onToggleReadingMode}
      />
      {noteData && !selectedTrashed && (
        <EditorToolbar
          editor={activeEditor}
          locale={locale}
          editing={editing}
          onToggleEditing={onToggleEditing}
          onImportMarkdown={noteData.type === "text" ? importMarkdown : undefined}
          onUploadImage={noteData.isProtected ? undefined : toolbarUploadImage}
          onCaptureImage={noteData.isProtected ? undefined : toolbarCaptureImage}
        />
      )}
      {tabs.some((tab) => tab.id === "search") && (
        <div className="document-scroll" data-tab-id="search" hidden={activeTabId !== "search"}>
          <Suspense fallback={<PageSuspenseFallback />}>
            <SearchPage client={client} locale={locale} isActive={activeTabId === "search"} onOpenNote={(noteId, openInNewTab) => openNote(noteId, false, false, openInNewTab)} initialTag={searchInitialTag} />
          </Suspense>
        </div>
      )}
      {activeTabId === "search" ? null : activeTabId === "archive" ? (
        <div className="document-scroll" data-tab-id="archive">
          <Suspense fallback={<PageSuspenseFallback />}>
            <ArchivedNotesPage
              items={archivedNotes.data ?? []}
              placements={treeData ?? []}
              loading={archivedNotes.isLoading}
              locale={locale}
              onOpen={(id) => openNote(id)}
              onUnarchive={(id) => archiveNote.mutate({ noteId: id, archived: false })}
            />
          </Suspense>
        </div>
      ) : activeTabId === "history" ? (
        <div className="document-scroll" data-tab-id="history">
          <Suspense fallback={<PageSuspenseFallback />}>
            <RecentHistory
              items={history.data ?? []}
              loading={history.isLoading}
              locale={locale}
              restoringNoteId={restoreNote.isPending ? (restoreNote as any).variables : undefined}
              purgingTrash={purgeTrash.isPending}
              onOpen={openNote as any}
              onRestore={(noteId) => restoreNote.mutate(noteId)}
              onPurgeTrash={() => setPurgeTrashConfirmation(true)}
            />
          </Suspense>
        </div>
      ) : activeTabId === "attachments" ? (
        <div className="document-scroll" data-tab-id="attachments">
          <Suspense fallback={<PageSuspenseFallback />}>
            <AttachmentsView
              data={attachments.data}
              isLoading={attachments.isLoading}
              locale={locale}
              onOpenNote={(noteId) => openNote(noteId)}
              onClearUnusedAttachments={() => setClearUnusedAttachmentsConfirmation(true)}
              clearingUnusedAttachments={clearUnusedAttachments.isPending}
              onDownloadAttachment={(hash) => client.downloadAttachmentByHash(hash)}
            />
          </Suspense>
        </div>
      ) : activeTabId === "graph" ? (
        <div className="document-scroll graph-scroll" data-tab-id="graph">
          <Suspense fallback={<PageSuspenseFallback />}>
            <GraphView
              client={client}
              locale={locale}
              onOpenNote={(noteId) => openNote(noteId)}
            />
          </Suspense>
        </div>
      ) : settingsOpen ? (
        <div className="document-scroll" data-tab-id="settings">
          <Suspense fallback={<PageSuspenseFallback />}>
          <SettingsPage
            locale={locale}
            onLocaleChange={onLocaleChange}
            purgingTrash={purgeTrash.isPending}
            onPurgeTrash={() => setPurgeTrashConfirmation(true)}
            clearingUnusedAttachments={clearUnusedAttachments.isPending}
            onClearUnusedAttachments={() => setClearUnusedAttachmentsConfirmation(true)}
            clearingExcessRevisions={clearingExcessRevisions}
            revisionCleanupMessage={revisionCleanupMessage}
            onClearExcessRevisions={onClearExcessRevisions}
            maintainingDatabase={maintainingDatabase}
            databaseMaintenanceMessage={databaseMaintenanceMessage}
            databaseMaintenanceMessageTarget={databaseMaintenanceMessageTarget}
            protectedSessionTimeoutMinutes={protectedSessionTimeoutMinutes}
            canChangeProtectedPassword={canChangeProtectedPassword}
            onChangeProtectedPassword={onChangeProtectedPassword}
            testingSyncConnection={testingSyncConnection}
            syncConnectionMessage={syncConnectionMessage}
            onTestSyncConnection={onTestSyncConnection}
            canMigrateToEmptyServer={canMigrateToEmptyServer}
            onMigrateToEmptyServer={onMigrateToEmptyServer}
            canOpenFrontendConsole={canOpenFrontendConsole}
            onOpenFrontendConsole={onOpenFrontendConsole}
            syncRunsAutomatically={syncRunsAutomatically}
            canEditSyncServerUrl={canEditSyncServerUrl}
            syncServerDisplayUrl={syncServerDisplayUrl}
            etapiAccessAvailable={etapiAccessAvailable}
            client={client}
            onProtectedSessionTimeoutChange={onProtectedSessionTimeoutChange}
            onMaintainDatabase={onMaintainDatabase}
          />
          </Suspense>
        </div>
      ) : activeTab?.kind === "new" ? (
        <div className="document-scroll" data-tab-id={activeTab.id}>
          <NewTabSearch
            treeData={treeData}
            locale={locale}
            decryptedTitles={decryptedTitles}
            openNote={openNote}
            createNewNote={createNewNote}
            creatingNote={createNote.isPending}
            client={client}
            onOpenTagSearch={(tag) => { setSearchInitialTag(tag); openSearch({ replaceActiveNewTab: true }); }}
          />
        </div>
      ) : noteIsLoading ? (
        <div className="document-scroll" data-tab-id={activeTabId}>
          <div className="empty">Loading...</div>
        </div>
      ) : noteData ? (
        <div ref={documentScrollRef} className="document-scroll" data-tab-id={activeTabId}>
          <NoteContent
            note={noteData}
            editing={editing}
            isTrashed={selectedTrashed}
            locale={locale}
            childNotes={childNotes}
            childrenByParent={childrenByParent}
            client={client}
            session={session}
            onSaveContent={autoSave}
            onSaveTitle={(nextTitle) => saveTitle.mutate(nextTitle)}
            onOpenChild={openChildNote}
            onChildMore={onChildMore}
            onUnarchive={onUnarchive}
            onEditorReady={onEditorReady}
            markdownView={markdownView}
            onUnlock={onProtectedSessionToggle}
            onUploadError={onUploadError}
          />
        </div>
      ) : (
        <div className="document-scroll" data-tab-id={activeTabId}>
          <NewTabSearch
            treeData={treeData}
            locale={locale}
            decryptedTitles={decryptedTitles}
            openNote={openNote}
            createNewNote={createNewNote}
            creatingNote={createNote.isPending}
            client={client}
            onOpenTagSearch={(tag) => { setSearchInitialTag(tag); openSearch({ replaceActiveNewTab: true }); }}
          />
        </div>
      )}
    </section>
  );
}

/** Keeps the scrolling tab container sized while a split page chunk loads. */
function PageSuspenseFallback() {
  return <div className="empty" />;
}
