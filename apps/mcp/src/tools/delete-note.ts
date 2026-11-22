import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerDeleteNote(server: McpServer, client: EtapiClient): void {
  server.registerTool(
    "delete_note",
    {
      title: "Move a Ygdria note to trash",
      description:
        "Move a note to the recoverable trash using the version from a prior read. Removes every placement (clone) of this note. Refuses system or protected notes and notes with children at any placement. Returns an undoId; restore through Ygdria. Does not permanently delete. On conflict, read current state and reconsider; do not blindly retry.",
      inputSchema: {
        noteId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, expectedVersion }) => {
      try {
        return success(await client.deleteNote(noteId, expectedVersion));
      } catch (error) {
        return failure(error);
      }
    },
  );
}
