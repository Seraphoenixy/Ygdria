import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerGetNote(server: McpServer, client: EtapiClient): void {
  server.registerTool(
    "get_note",
    {
      title: "Read a Ygdria note",
      description:
        "Read a note through ETAPI. Read current content before replacing existing text; retain the returned version. A current note resource or prior write response can also supply the version.",
      inputSchema: {
        noteId: z.string().min(1),
        format: z
          .enum(["markdown", "json", "html"])
          .optional()
          .default("markdown"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId, format }) => {
      try {
        return success(await client.getNote(noteId, format));
      } catch (error) {
        return failure(error);
      }
    },
  );
}
