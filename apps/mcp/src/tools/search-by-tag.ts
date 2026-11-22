import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerSearchByTag(server: McpServer, client: EtapiClient): void {
  server.registerTool(
    "search_by_tag",
    {
      title: "Search Ygdria notes by tag",
      description:
        "Find notes with an exact Ygdria tag, optionally limited to a placement and all its descendants.",
      inputSchema: {
        tag: z.string().min(1).describe("Exact tag to search for"),
        includeArchived: z.boolean().optional().default(false),
        placementId: z.string().min(1).optional().describe("Optional placement root; includes this tree node and all descendants"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ tag, includeArchived, placementId }) => {
      try {
        return success(await client.searchByTag(tag, includeArchived, placementId));
      } catch (error) {
        return failure(error);
      }
    },
  );
}
