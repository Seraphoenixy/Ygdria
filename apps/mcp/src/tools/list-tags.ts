import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtapiClient } from "../client/etapi-client.js";
import { failure, success } from "./shared.js";

export function registerListTags(server: McpServer, client: EtapiClient): void {
  server.registerTool(
    "list_tags",
    {
      title: "List Ygdria tags",
      description: "List all tags available through Ygdria ETAPI.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return success(await client.listTags());
      } catch (error) {
        return failure(error);
      }
    },
  );
}
