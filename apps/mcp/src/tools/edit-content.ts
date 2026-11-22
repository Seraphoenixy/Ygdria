import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EtapiError, type EtapiClient } from "../client/etapi-client.js";
import { failure, success, versionConflict } from "./shared.js";

export function registerEditContent(
  server: McpServer,
  client: EtapiClient,
): void {
  server.registerTool(
    "edit_content",
    {
      title: "Precisely edit Ygdria note content",
      description:
        "Apply atomic literal oldText/newText edits to a note read earlier with get_note. Each target must match exactly as expected; use dryRun to preview.",
      inputSchema: {
        noteId: z.string().min(1),
        expectedVersion: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Version from the last read or write response"),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Legacy alias for expectedVersion"),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .min(1)
                .describe(
                  "Exact, case- and newline-sensitive text from the current Markdown body",
                ),
              newText: z.string(),
              expectedMatches: z.number().int().positive().optional(),
            }),
          )
          .min(1)
          .max(100),
        dryRun: z.boolean().optional().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ noteId, expectedVersion, version, edits, dryRun }) => {
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
          await client.editContent(noteId, {
            expectedVersion: currentVersion,
            edits,
            dryRun,
          }),
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
