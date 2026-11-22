import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EtapiError, type EtapiClient } from "../client/etapi-client.js";
import { failure, success, versionConflict } from "./shared.js";

export function registerUpdateNote(
  server: McpServer,
  client: EtapiClient,
): void {
  server.registerTool(
    "update_note",
    {
      title: "Update a Ygdria note",
      description:
        "Update title, body, or tags using the current version from a read, resource, or prior write response. On conflict, this tool reads and returns the latest note; reconsider the edit and never retry the stale version.",
      inputSchema: {
        noteId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        codeLanguage: z.string().min(1).max(64).optional(),
        title: z.string().min(1).optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, ...update }) => {
      try {
        return success(await client.updateNote(noteId, update));
      } catch (error) {
        if (error instanceof EtapiError && error.status === 409) {
          return versionConflict(client, noteId);
        }
        return failure(error);
      }
    },
  );
}
