import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerCreateNote(
  server: McpServer,
  client: EtapiClient,
): void {
  server.registerTool(
    "create_note",
    {
      title: "Create a Ygdria note",
      description:
        "Create a note within the user-authorized task, including necessary notes for organizing or summarizing. Use a unique idempotencyKey; on an uncertain network result retry only with the same key and identical parameters within 30 days.",
      inputSchema: {
        title: z.string().min(1),
        parentPlacementId: z.string().min(1).optional(),
        type: z.enum(["text", "code"]).optional().default("text"),
        content: z.string().default(""),
        idempotencyKey: z.string().min(1).max(200).optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return success(await client.createNote(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
}
