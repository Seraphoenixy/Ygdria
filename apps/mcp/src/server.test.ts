import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";

async function inspectServer(): Promise<{
  tools: string[];
  resourceTemplates: string[];
}> {
  const server = createServer({
    baseUrl: "http://127.0.0.1:4318",
  });
  const client = new Client({ name: "ygdria-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const [tools, templates] = await Promise.all([
      client.listTools(),
      client.listResourceTemplates(),
    ]);
    return {
      tools: tools.tools.map((tool) => tool.name).sort(),
      resourceTemplates: templates.resourceTemplates.map(
        (template) => template.uriTemplate,
      ),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

test("all tools are available under the Ygdria access switch", async () => {
  const result = await inspectServer();
  assert.deepEqual(result.resourceTemplates, ["ygdria://note/{noteId}"]);
  assert.deepEqual(result.tools, [
    "append_content",
    "create_note",
    "edit_content",
    "get_note",
    "get_notes",
    "get_section",
    "get_tree_node",
    "get_tree_overview",
    "get_tree_subtree",
    "list_tags",
    "list_tree_children",
    "list_tree_roots",
    "move_placement",
    "move_placements",
    "replace_content",
    "replace_section",
    "resolve_tree_nodes",
    "search_by_tag",
    "search_notes",
    "update_note",
    "update_tags",
  ]);
});
