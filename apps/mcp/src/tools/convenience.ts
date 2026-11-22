import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

type TreeNode = {
  placementId: string;
  hasChildren: boolean;
  [key: string]: unknown;
};
type Page = { items: TreeNode[]; nextCursor: string | null };
const pendingSchema = z.object({
  parentPlacementId: z.string().optional(),
  cursor: z.string().optional(),
  depth: z.number().int().min(1).max(10),
});

/** Depth-first page traversal keeps the continuation frontier bounded by depth, not library size. */
export async function treeOverview(
  client: Pick<EtapiClient, "getTreeRoots" | "getTreeChildren">,
  input: {
    maxDepth: number;
    maxNodes: number;
    maxBytes: number;
    maxRequests: number;
    includeArchived: boolean;
    placementId?: string;
    continuation?: {
      pending: Array<z.infer<typeof pendingSchema>>;
      includeArchived: boolean;
      maxDepth: number;
    };
  },
) {
  if (
    input.continuation &&
    (input.continuation.includeArchived !== input.includeArchived ||
      input.continuation.maxDepth !== input.maxDepth)
  )
    throw new Error(
      "Continuation requires the same includeArchived and maxDepth",
    );
  const pending = input.continuation?.pending.map((item) => ({ ...item })) ?? [
    { parentPlacementId: input.placementId, depth: 1 },
  ];
  const items: TreeNode[] = [];
  const unexpandedPlacementIds: string[] = [];
  let bytes = 2,
    requests = 0,
    byteLimited = false;
  while (
    items.length < input.maxNodes &&
    pending.length &&
    requests < input.maxRequests &&
    !byteLimited
  ) {
    const task = pending.shift()!;
    const options = {
      includeArchived: input.includeArchived,
      limit: Math.min(100, input.maxNodes - items.length),
      cursor: task.cursor,
    };
    const page = (await (task.parentPlacementId
      ? client.getTreeChildren(task.parentPlacementId, options)
      : client.getTreeRoots(options))) as Page;
    requests++;
    const children: Array<z.infer<typeof pendingSchema>> = [];
    let consumed = 0;
    for (const node of page.items) {
      const size = Buffer.byteLength(JSON.stringify(node, null, 2), "utf8") + 1;
      if (bytes + size > input.maxBytes) {
        byteLimited = true;
        break;
      }
      items.push(node);
      bytes += size;
      consumed++;
      if (node.hasChildren) {
        if (task.depth < input.maxDepth)
          children.push({
            parentPlacementId: node.placementId,
            depth: task.depth + 1,
          });
        else unexpandedPlacementIds.push(node.placementId);
      }
    }
    const cursor =
      consumed < page.items.length
        ? consumed
          ? page.items[consumed - 1]!.placementId
          : task.cursor
        : page.nextCursor;
    if (consumed < page.items.length || page.nextCursor)
      pending.unshift({ ...task, cursor: cursor ?? undefined });
    pending.unshift(...children);
  }
  const hasMore = pending.length > 0;
  return {
    items,
    requests,
    truncated: hasMore || unexpandedPlacementIds.length > 0,
    unexpandedPlacementIds,
    continuation: hasMore
      ? {
          pending,
          includeArchived: input.includeArchived,
          maxDepth: input.maxDepth,
        }
      : null,
  };
}

export function registerConvenienceTools(
  server: McpServer,
  client: EtapiClient,
) {
  server.registerTool(
    "get_tree_overview",
    {
      description:
        "Explore roots or a placement's descendants automatically within node, depth, item-byte, and request budgets. Pass returned continuation to continue; depth-limited nodes are listed separately. Byte budget covers items; continuation is additional bounded navigation data.",
      inputSchema: {
        placementId: z.string().min(1).optional(),
        includeArchived: z.boolean().default(false),
        maxDepth: z.number().int().min(1).max(10).default(3),
        maxNodes: z.number().int().min(1).max(500).default(100),
        maxBytes: z.number().int().min(4096).max(1_000_000).default(200_000),
        maxRequests: z.number().int().min(1).max(200).default(50),
        continuation: z
          .object({
            pending: z.array(pendingSchema).max(1000),
            includeArchived: z.boolean(),
            maxDepth: z.number().int().min(1).max(10),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await treeOverview(client, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_notes",
    {
      description:
        "Read up to 50 notes with per-note results. Choose metadata, excerpt, or full Markdown; a byte budget defers remaining IDs for another call. Protected notes remain inaccessible.",
      inputSchema: {
        noteIds: z.array(z.string().min(1)).min(1).max(50),
        view: z.enum(["metadata", "excerpt", "full"]).default("full"),
        excerptLength: z.number().int().min(1).max(5000).default(500),
        maxBytes: z.number().int().min(4096).max(5_000_000).default(500_000),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteIds, view, excerptLength, maxBytes }) => {
      const items: unknown[] = [];
      let bytes = 2;
      const remainingNoteIds: string[] = [];
      for (const [index, id] of noteIds.entries()) {
        let item: unknown;
        try {
          const note = await client.getNote(id, "markdown");
          const { content, ...metadata } = note;
          item = {
            ok: true,
            note:
              view === "metadata"
                ? metadata
                : view === "excerpt"
                  ? {
                      ...metadata,
                      excerpt: String(content).slice(0, excerptLength),
                    }
                  : note,
          };
        } catch (error) {
          item = { ok: false, noteId: id, error: failure(error) };
        }
        const size = Buffer.byteLength(JSON.stringify(item, null, 2), "utf8") + 1;
        if (bytes + size > maxBytes) {
          remainingNoteIds.push(...noteIds.slice(index));
          break;
        }
        bytes += size;
        items.push(item);
      }
      return success({
        items,
        remainingNoteIds,
        truncated: remainingNoteIds.length > 0,
      });
    },
  );
  server.registerTool(
    "get_section",
    {
      description:
        "Read a unique heading section body and current version. Pass the returned content unchanged as oldText to replace_section; headingPath lists ancestor titles and the target heading.",
      inputSchema: {
        noteId: z.string().min(1),
        headingPath: z.array(z.string().min(1)).min(1).max(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId, headingPath }) => {
      try {
        return success(await client.getSection(noteId, headingPath));
      } catch (error) {
        return failure(error);
      }
    },
  );
  const noteId = z.string().min(1);
  const expectedVersion = z.number().int().positive().optional();
  const key = z.string().min(1).max(200);
  server.registerTool(
    "append_content",
    {
      description:
        "Append Markdown blocks (or literal code) to the latest note without replacing existing content. Required idempotencyKey makes retries safe for 30 days on the same local Ygdria database. Optionally require expectedVersion.",
      inputSchema: {
        noteId,
        text: z.string().min(1).max(1_000_000),
        idempotencyKey: key,
        expectedVersion,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ noteId, idempotencyKey, ...input }) => {
      try {
        return success(
          await client.operateNote(
            noteId,
            { operation: "append", ...input },
            idempotencyKey,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "update_tags",
    {
      description:
        "Add and remove tags on the latest note without replacing unrelated tags. Additions win if a tag appears in both lists.",
      inputSchema: {
        noteId,
        addTags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
        removeTags: z
          .array(z.string().trim().min(1).max(64))
          .max(20)
          .default([]),
        expectedVersion,
        idempotencyKey: key.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, idempotencyKey, ...input }) => {
      try {
        return success(
          await client.operateNote(
            noteId,
            { operation: "tags", ...input },
            idempotencyKey,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "replace_section",
    {
      description:
        "Replace the body under a unique hierarchy of heading titles, preserving its heading and all outside Tiptap nodes. Use get_section first. oldText is the exact returned Markdown section body, including nested subsections. Requires current expectedVersion. Ambiguous paths fail atomically.",
      inputSchema: {
        noteId,
        headingPath: z.array(z.string().min(1)).min(1).max(10),
        oldText: z.string().max(1_000_000),
        text: z.string().max(1_000_000),
        expectedVersion: z.number().int().positive(),
        idempotencyKey: key.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, idempotencyKey, ...input }) => {
      try {
        return success(
          await client.operateNote(
            noteId,
            { operation: "replace_section", ...input },
            idempotencyKey,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "move_placements",
    {
      description:
        "Move up to 50 placements sequentially. Each move is independent; returns per-item results and partial success, without cross-request atomicity. Stops on authentication or permission errors.",
      inputSchema: {
        moves: z
          .array(
            z.object({
              placementId: z.string().min(1),
              parentPlacementId: z.string().min(1),
              position: z.number().int().nonnegative().default(0),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ moves }) => {
      const items: unknown[] = [];
      for (const { placementId, ...input } of moves) {
        try {
          items.push({
            placementId,
            ok: true,
            result: await client.movePlacement(placementId, input),
          });
        } catch (error) {
          items.push({ placementId, ok: false, error: failure(error) });
          if (
            error &&
            typeof error === "object" &&
            "status" in error &&
            (error.status === 401 || error.status === 403)
          )
            break;
        }
      }
      return success({
        items,
        processed: items.length,
        unprocessed: moves.slice(items.length),
      });
    },
  );
}
