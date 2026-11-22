import type {
  JsonObject,
  Note,
  NoteFormat,
  SearchNoteItem,
  SearchNotesResponse,
} from "../types/index.js";

export class EtapiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EtapiError";
  }
}

export class EtapiNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EtapiNetworkError";
  }
}

export interface EtapiClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateNoteInput {
  title: string;
  parentPlacementId?: string;
  type?: "text" | "code";
  content: string;
  tags?: string[];
  idempotencyKey?: string;
}

export interface UpdateNoteInput {
  expectedVersion: number;
  codeLanguage?: string;
  title?: string;
  content?: string;
  tags?: string[];
}

export interface MovePlacementInput {
  parentPlacementId: string;
  position: number;
}

export interface EditContentInput {
  expectedVersion: number;
  edits: Array<{
    oldText: string;
    newText: string;
    expectedMatches?: number;
  }>;
  dryRun?: boolean;
}

function asRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stripHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function noteFromResponse(value: unknown): Note {
  const source = asRecord(value);
  return {
    id: String(source.id ?? ""),
    title: String(source.title ?? ""),
    type: String(source.type ?? ""),
    content: source.content ?? "",
    contentFormat: String(source.contentFormat ?? ""),
    properties: source.properties ?? {},
    placements: source.placements ?? [],
    version: Number(source.version),
  };
}

export class EtapiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: EtapiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async searchNotes(
    query: string,
    includeArchived = false,
    placementId?: string,
    tag?: string,
  ): Promise<SearchNotesResponse> {
    return this.search({
      ...(tag ? { tag } : {}),
      q: query,
      ...(placementId ? { placementId } : {}),
      includeArchived: String(includeArchived),
    });
  }

  async searchByTag(
    tag: string,
    includeArchived = false,
    placementId?: string,
  ): Promise<SearchNotesResponse> {
    return this.search({
      tag,
      ...(placementId ? { placementId } : {}),
      includeArchived: String(includeArchived),
    });
  }

  listTags(): Promise<unknown> {
    return this.request("/etapi/tags");
  }

  private async search(
    params: Record<string, string>,
  ): Promise<SearchNotesResponse> {
    const response = await this.request<unknown>(
      `/etapi/search?${new URLSearchParams(params)}`,
    );
    const rawItems = Array.isArray(response)
      ? response
      : Array.isArray(asRecord(response).items)
        ? (asRecord(response).items as unknown[])
        : [];

    const items = rawItems
      .map(asRecord)
      .filter((item) => item.isProtected !== true && item.protected !== true)
      .map((item): SearchNoteItem => ({
        noteId: String(item.id ?? item.noteId ?? ""),
        title: String(item.title ?? ""),
        snippet: stripHtml(item.snippet),
        updatedAt: String(item.updatedAt ?? ""),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        ...(Array.isArray(item.matchedPlacementIds)
          ? { matchedPlacementIds: item.matchedPlacementIds.map(String) }
          : {}),
      }));

    return { items };
  }

  private treeParams(
    input: Record<string, string | number | boolean | undefined>,
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) params.set(key, String(value));
    return params;
  }

  getTreeRoots(
    input: { includeArchived?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<unknown> {
    return this.request(`/etapi/tree/roots?${this.treeParams(input)}`);
  }

  getTreeNode(placementId: string, includeArchived = false): Promise<unknown> {
    return this.request(
      `/etapi/tree/nodes/${encodeURIComponent(placementId)}?${this.treeParams({ includeArchived })}`,
    );
  }

  getTreeChildren(
    placementId: string,
    input: { includeArchived?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<unknown> {
    return this.request(
      `/etapi/tree/nodes/${encodeURIComponent(placementId)}/children?${this.treeParams(input)}`,
    );
  }

  getTreeSubtree(
    placementId: string,
    input: {
      includeArchived?: boolean;
      maxDepth?: number;
      maxNodes?: number;
    } = {},
  ): Promise<unknown> {
    return this.request(
      `/etapi/tree/nodes/${encodeURIComponent(placementId)}/subtree?${this.treeParams(input)}`,
    );
  }

  resolveTreeNodes(input: {
    query: string;
    parentPlacementId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<unknown> {
    return this.request(`/etapi/tree/resolve?${this.treeParams(input)}`);
  }

  async getNote(
    noteId: string,
    format: NoteFormat = "markdown",
  ): Promise<Note> {
    const params = new URLSearchParams({ format });
    const response = await this.request<unknown>(
      `/etapi/notes/${encodeURIComponent(noteId)}?${params}`,
    );
    return noteFromResponse(response);
  }

  getSection(noteId: string, headingPath: string[]): Promise<unknown> {
    return this.request(
      `/etapi/notes/${encodeURIComponent(noteId)}/section?${new URLSearchParams({ path: JSON.stringify(headingPath) })}`,
    );
  }

  capabilities(): Promise<{ access: string }> {
    return this.request("/etapi/capabilities");
  }

  operateNote(
    noteId: string,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.request(
      `/etapi/notes/${encodeURIComponent(noteId)}/operations`,
      {
        method: "POST",
        json: input,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      },
    );
  }

  createNote(input: CreateNoteInput): Promise<unknown> {
    const { idempotencyKey, ...body } = input;
    return this.request("/etapi/notes", {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      json: body,
    });
  }

  updateNote(noteId: string, input: UpdateNoteInput): Promise<unknown> {
    return this.request(`/etapi/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      json: input,
    });
  }

  replaceContent(
    noteId: string,
    version: number,
    content: string,
  ): Promise<unknown> {
    return this.request(`/etapi/notes/${encodeURIComponent(noteId)}/content`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "If-Match": String(version),
      },
      body: content,
    });
  }

  editContent(noteId: string, input: EditContentInput): Promise<unknown> {
    return this.request(`/etapi/notes/${encodeURIComponent(noteId)}/content`, {
      method: "PATCH",
      json: input,
    });
  }

  movePlacement(
    placementId: string,
    input: MovePlacementInput,
  ): Promise<unknown> {
    return this.request(
      `/etapi/placements/${encodeURIComponent(placementId)}`,
      {
        method: "PATCH",
        json: input,
      },
    );
  }

  private async request<T>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      json?: unknown;
    } = {},
  ): Promise<T> {
    if (!path.startsWith("/etapi/")) {
      throw new Error("Refusing to call a non-ETAPI path.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Ygdria-External-Access": "1",
      ...init.headers,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? `ETAPI request timed out after ${this.timeoutMs}ms.`
          : "Could not reach Ygdria ETAPI.";
      throw new EtapiNetworkError(reason, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      if (contentType.includes("json")) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      } else {
        payload = text;
      }
    }

    if (!response.ok) {
      throw new EtapiError(
        response.status,
        statusMessage(response.status),
        payload,
      );
    }

    return payload as T;
  }
}

function statusMessage(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Ygdria external access is unavailable. Enable AI and external access in Ygdria settings, then call again. No token is needed.";
    case 404:
      return "The requested Ygdria note or placement does not exist.";
    case 409:
      return "The note changed since it was read. Read the latest version and reconsider the update.";
    case 415:
      return "ETAPI rejected the request Content-Type.";
    case 422:
      return "ETAPI could not apply the precise edit. Re-read the note and use unique, non-overlapping literal text targets.";
    default:
      return `Ygdria ETAPI request failed with HTTP ${status}.`;
  }
}
