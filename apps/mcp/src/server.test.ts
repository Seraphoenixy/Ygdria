import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EtapiClient } from "./client/etapi-client.js";
import { registerDeleteNote } from "./tools/delete-note.js";

async function inspectServer(): Promise<{
  tools: string[];
  resourceTemplates: string[];
}> {
  const server = createServer({
    baseUrl: "http://127.0.0.1:4318",
  });
  const client = new Client({ name: "ygdria-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const [tools, templates] = await Promise.all([
      client.listTools(),
      client.listResourceTemplates(),
    ]);
    return {
      tools: tools.tools.map((tool) => tool.name).sort(),
      resourceTemplates: templates.resourceTemplates.map((template) => template.uriTemplate),
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
    "delete_note",
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

test("delete_note validates the version and reports success and structural conflicts through MCP", async () => {
  let calls = 0;
  const server = new McpServer({ name: "delete-test", version: "1.0.0" });
  registerDeleteNote(
    server,
    new EtapiClient({
      baseUrl: "http://127.0.0.1:4318",
      fetchImpl: (async () => {
        calls++;
        return calls === 1
          ? Response.json({ id: "note-1", deleted: true, undoId: "undo-1" })
          : Response.json({ error: { message: "Note has child placements" } }, { status: 409 });
      }) as typeof fetch,
    }),
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools[0];
    assert.ok(tool);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.ok(tool.inputSchema.required?.includes("expectedVersion"));
    for (const args of [{ noteId: "note-1" }, { noteId: "note-1", expectedVersion: 0 }]) {
      const invalid = await client.callTool({ name: "delete_note", arguments: args });
      assert.equal(invalid.isError, true);
    }
    assert.equal(calls, 0);
    const deleted = await client.callTool({
      name: "delete_note",
      arguments: { noteId: "note-1", expectedVersion: 1 },
    });
    assert.deepEqual(deleted.structuredContent, { id: "note-1", deleted: true, undoId: "undo-1" });
    const conflict = await client.callTool({
      name: "delete_note",
      arguments: { noteId: "note-2", expectedVersion: 1 },
    });
    assert.equal(conflict.isError, true);
    const content = (conflict.content as Array<{ type: string; text: string }>)[0];
    assert.ok(content);
    assert.equal(JSON.parse(content.text).status, 409);
    assert.equal(JSON.parse(content.text).details.error.message, "Note has child placements");
    assert.equal(calls, 2);
  } finally {
    await client.close();
    await server.close();
  }
});
