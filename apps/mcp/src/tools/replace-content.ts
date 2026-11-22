import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EtapiError, type EtapiClient } from "../client/etapi-client.js";
import { failure, success, versionConflict } from "./shared.js";

export function registerReplaceContent(
  server: McpServer,
  client: EtapiClient,
): void {
  server.registerTool(
    "replace_content",
    {
      title: "Replace Ygdria note content",
      description:
        "Replace the complete Markdown body using the version from a prior get_note call as If-Match.",
      inputSchema: {
        noteId: z.string().min(1),
        expectedVersion: z.number().int().positive().optional(),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Legacy alias for expectedVersion"),
        content: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, expectedVersion, version, content }) => {
      try {
        const currentVersion = expectedVersion ?? version;
        if (
          !currentVersion ||
          (expectedVersion !== undefined &&
            version !== undefined &&
            expectedVersion !== version)
        )
          throw new Error(
            "Provide expectedVersion; legacy version must agree if supplied",
          );
        return success(
          await client.replaceContent(noteId, currentVersion, content),
        );
      } catch (error) {
        if (error instanceof EtapiError && error.status === 409) {
          return versionConflict(client, noteId);
        }
        return failure(error);
      }
    },
  );
}
