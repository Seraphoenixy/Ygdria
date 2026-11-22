import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

const pageInput = {
  includeArchived: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().min(1).optional(),
};

export function registerTreeNavigation(server: McpServer, client: EtapiClient): void {
  server.registerTool("list_tree_roots", {
    title: "List Ygdria tree roots",
    description: "List only top-level tree nodes, paginated. Use resolve_tree_nodes for direct lookup or get_tree_overview for a budgeted overview.",
    inputSchema: pageInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    try { return success(await client.getTreeRoots(input)); } catch (error) { return failure(error); }
  });

  server.registerTool("get_tree_node", {
    title: "Get a Ygdria tree node",
    description: "Read compact metadata for exactly one placement node.",
    inputSchema: { placementId: z.string().min(1), includeArchived: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ placementId, includeArchived }) => {
    try { return success(await client.getTreeNode(placementId, includeArchived)); } catch (error) { return failure(error); }
  });

  server.registerTool("list_tree_children", {
    title: "List direct Ygdria tree children",
    description: "List direct child placement nodes, paginated. Use hasChildren to decide whether further expansion is useful.",
    inputSchema: { placementId: z.string().min(1), ...pageInput },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ placementId, ...input }) => {
    try { return success(await client.getTreeChildren(placementId, input)); } catch (error) { return failure(error); }
  });

  server.registerTool("get_tree_subtree", {
    title: "Get a bounded Ygdria subtree",
    description: "Read one placement and its descendants within explicit depth and node limits; use get_tree_overview to explore across roots within a response budget.",
    inputSchema: {
      placementId: z.string().min(1), includeArchived: z.boolean().optional().default(false),
      maxDepth: z.number().int().min(1).max(10).default(1), maxNodes: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ placementId, ...input }) => {
    try { return success(await client.getTreeSubtree(placementId, input)); } catch (error) { return failure(error); }
  });

  server.registerTool("resolve_tree_nodes", {
    title: "Resolve Ygdria tree nodes by name",
    description: "Find candidate placement nodes by a title fragment, then navigate with their placementId values.",
    inputSchema: {
      query: z.string().trim().min(1).max(500), parentPlacementId: z.string().min(1).optional(),
      includeArchived: z.boolean().optional().default(false), limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    try { return success(await client.resolveTreeNodes(input)); } catch (error) { return failure(error); }
  });
}
