import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerMovePlacement(server: McpServer, client: EtapiClient): void {
  server.registerTool(
    "move_placement",
    {
      title: "Move a Ygdria placement",
      description:
        "Move a placement tree node. placementId, not noteId, identifies the item being moved.",
      inputSchema: {
        placementId: z.string().min(1),
        parentPlacementId: z.string().min(1),
        position: z.number().int().nonnegative(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ placementId, parentPlacementId, position }) => {
      try {
        return success(
          await client.movePlacement(placementId, { parentPlacementId, position }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
