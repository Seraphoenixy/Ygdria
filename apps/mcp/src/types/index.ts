export type NoteFormat = "markdown" | "json" | "html";
export type NoteType = "text" | "code";

export interface SearchNoteItem {
  /** Identifier accepted by get_note, update_note, and replace_content. */
  noteId: string;
  title: string;
  snippet: string;
  updatedAt: string;
  tags: string[];
  /** Tree positions matching the requested placement subtree (including clones). */
  matchedPlacementIds?: string[];
}

export interface SearchNotesResponse {
  items: SearchNoteItem[];
}

export interface Note {
  id: string;
  title: string;
  type: string;
  content: unknown;
  contentFormat: string;
  properties: unknown;
  placements: unknown;
  version: number;
}

export type JsonObject = Record<string, unknown>;
