export type TreePlacement = {
  placementId: string;
  noteId: string;
  parentPlacementId: string | null;
  position: number;
  title: string;
  type?: "text" | "code" | "file";
  /** Present for protected notes — the ciphertext payload stored on the server. */
  contentJson?: string;
  isTrashed?: boolean;
  isArchived?: boolean;
  isSystem?: boolean;
  isCalendar?: boolean;
  isTrash?: boolean;
  isProtected?: boolean;
};

export type ContextMenuState = { placement: TreePlacement; x: number; y: number } | null;

export type RecentHistoryItem = {
  id: string;
  title: string;
  path: string[];
  updatedAt: string;
  isTrashed?: boolean;
};

export type WorkspaceTab =
  | { id: "settings"; kind: "settings" }
  | { id: "search"; kind: "search" }
  | { id: "history"; kind: "history" }
  | { id: "archive"; kind: "archive" }
  | { id: "attachments"; kind: "attachments" }
  | { id: string; kind: "new" }
  | { id: string; kind: "note"; noteId: string; isTrashed: boolean; placementId?: string };

export type TabMenuState = { tabId: string; x: number; y: number } | null;
