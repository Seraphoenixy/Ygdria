import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerSearchNotes(
  server: McpServer,
  client: EtapiClient,
): void {
  server.registerTool(
    "search_notes",
    {
      title: "Search Ygdria notes",
      description:
        "Search Ygdria notes through ETAPI. Optionally limit results to a placement and all its descendants. Results use noteId for follow-up note tools; snippets are plain text.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for"),
        tag: z
          .string()
          .min(1)
          .optional()
          .describe("Optional exact tag filter combined with the query"),
        includeArchived: z.boolean().optional().default(false),
        placementId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional placement root; includes this tree node and all descendants",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, includeArchived, placementId, tag }) => {
      try {
        return success(
          await client.searchNotes(query, includeArchived, placementId, tag),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
