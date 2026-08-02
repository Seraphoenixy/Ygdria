import React, { type RefObject } from "react";
import type { YgdriaClient } from "@ygdria/api-client";
import type { Locale } from "../../lib/i18n";
import type { TreePlacement, WorkspaceTab } from "../../types/workspace";
import type { BreadcrumbSegment } from "../chrome/Toolbar";
import { TabBar } from "../chrome/TabBar";
import { Toolbar } from "../chrome/Toolbar";
import { EditorToolbar } from "@ygdria/editor";
import { SearchPage } from "../../features/workspace/SearchPage";
import { NewTabSearch } from "../../features/workspace/NewTabSearch";
import { ArchivedNotesPage, RecentHistory } from "../../features/workspace/pages";
import { AttachmentsView } from "../../features/workspace/AttachmentsView";
import { NoteContent } from "../../features/note/NoteContent";
import type { NoteContentData } from "../../features/note/NoteContent";
import { SettingsPage } from "../../features/settings/SettingsPage";
import type { ProtectedClientSession } from "../../lib/client-crypto";

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
  onTabContextMenu: (tabId: string, x: number, y: number) => void;

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
  clearUnusedAttachmentsConfirmation: boolean;
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
  onTabContextMenu,
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
  clearUnusedAttachmentsConfirmation,
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
  createNote,
  createNewNote,
  decryptedTitles,
}: WorkspaceContentProps) {
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
          noteData && !selectedTrashed && !noteData.isProtected && noteData.type !== "file",
        )}
        onConvertNote={() =>
          noteData && convertNote.mutate(noteData.type === "code" ? "text" : "code")
        }
        canViewRevisionHistory={Boolean(
          noteData && !selectedTrashed && !noteData.isProtected && noteData.type !== "file",
        )}
        onViewRevisionHistory={onViewRevisionHistory}
        onToggleMarkdownView={
          noteData?.type === "text" && !selectedTrashed && editing ? toggleMarkdownView : undefined
        }
        markdownView={markdownView}
      />
      {noteData && !selectedTrashed && (
        <EditorToolbar
          editor={activeEditor}
          locale={locale}
          editing={editing}
          onToggleEditing={onToggleEditing}
          onImportMarkdown={noteData.type === "text" ? importMarkdown : undefined}
        />
      )}
      {activeTabId === "search" ? (
        <div className="document-scroll">
          <SearchPage client={client} locale={locale} onOpenNote={(noteId) => openNote(noteId)} />
        </div>
      ) : activeTabId === "archive" ? (
        <div className="document-scroll">
          <ArchivedNotesPage
            items={archivedNotes.data ?? []}
            placements={treeData ?? []}
            loading={archivedNotes.isLoading}
            locale={locale}
            onOpen={(id) => openNote(id)}
            onUnarchive={(id) => archiveNote.mutate({ noteId: id, archived: false })}
          />
        </div>
      ) : activeTabId === "history" ? (
        <div className="document-scroll">
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
        </div>
      ) : activeTabId === "attachments" ? (
        <div className="document-scroll">
          <AttachmentsView
            data={attachments.data}
            isLoading={attachments.isLoading}
            locale={locale}
            onOpenNote={(noteId) => openNote(noteId)}
            onClearUnusedAttachments={() => setClearUnusedAttachmentsConfirmation(true)}
            clearingUnusedAttachments={clearUnusedAttachments.isPending}
          />
        </div>
      ) : settingsOpen ? (
        <div className="document-scroll">
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
            onProtectedSessionTimeoutChange={onProtectedSessionTimeoutChange}
            onMaintainDatabase={onMaintainDatabase}
          />
        </div>
      ) : activeTab?.kind === "new" ? (
        <div className="document-scroll">
          <NewTabSearch
            treeData={treeData}
            locale={locale}
            decryptedTitles={decryptedTitles}
            openNote={openNote}
            createNewNote={createNewNote}
            creatingNote={createNote.isPending}
          />
        </div>
      ) : noteIsLoading ? (
        <div className="document-scroll">
          <div className="empty">Loading...</div>
        </div>
      ) : noteData ? (
        <div ref={documentScrollRef} className="document-scroll">
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
          />
        </div>
      ) : (
        <div className="document-scroll">
          <NewTabSearch
            treeData={treeData}
            locale={locale}
            decryptedTitles={decryptedTitles}
            openNote={openNote}
            createNewNote={createNewNote}
            creatingNote={createNote.isPending}
          />
        </div>
      )}
    </section>
  );
}
