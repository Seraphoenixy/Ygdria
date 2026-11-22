#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EtapiClient } from "./client/etapi-client.js";
import { loadConfig, type Config } from "./config.js";
import { registerCreateNote } from "./tools/create-note.js";
import { registerEditContent } from "./tools/edit-content.js";
import { registerGetNote } from "./tools/get-note.js";
import { registerTreeNavigation } from "./tools/get-tree.js";
import { registerListTags } from "./tools/list-tags.js";
import { registerMovePlacement } from "./tools/move-placement.js";
import { registerReplaceContent } from "./tools/replace-content.js";
import { registerSearchNotes } from "./tools/search-notes.js";
import { registerSearchByTag } from "./tools/search-by-tag.js";
import { registerConvenienceTools } from "./tools/convenience.js";
import { registerUpdateNote } from "./tools/update-note.js";

export function createServer(config: Config): McpServer {
  const client = new EtapiClient({ baseUrl: config.baseUrl });
  const server = new McpServer(
    { name: "ygdria-mcp", version: "0.1.0" },
    {
      instructions:
        "Ygdria's local external access switch controls all tools. If disabled, ask the user to enable AI and external access in Ygdria settings, then call again; no token or restart is needed. Execute necessary reads and writes within the user-authorized task without asking for each step. Read existing content before replacing it and use its current version. Prefer focused edits. Use idempotency keys for creation and append; retry uncertain writes with the same key and parameters within 30 days. Protected notes remain inaccessible. Placements, not notes, are tree nodes.",
    },
  );

  registerConvenienceTools(server, client);
  registerSearchNotes(server, client);
  registerSearchByTag(server, client);
  registerListTags(server, client);
  registerTreeNavigation(server, client);
  registerGetNote(server, client);

  registerCreateNote(server, client);
  registerUpdateNote(server, client);
  registerEditContent(server, client);
  registerReplaceContent(server, client);
  registerMovePlacement(server, client);

  server.registerResource(
    "ygdria-note",
    new ResourceTemplate("ygdria://note/{noteId}", { list: undefined }),
    {
      title: "Ygdria note",
      description: "Read a Ygdria note as Markdown through ETAPI.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const rawNoteId = variables.noteId;
      const noteId = Array.isArray(rawNoteId) ? rawNoteId[0] : rawNoteId;
      if (!noteId) {
        throw new Error("The Ygdria resource URI must contain a noteId.");
      }
      const note = await client.getNote(noteId, "markdown");
      const text =
        typeof note.content === "string"
          ? note.content
          : JSON.stringify(note.content, null, 2);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `<!-- Ygdria noteId=${note.id} version=${note.version} -->
${text}`,
          },
        ],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // stdout is reserved for MCP JSON-RPC messages.
    console.error(`ygdria-mcp: ${message}`);
    process.exitCode = 1;
  });
}
