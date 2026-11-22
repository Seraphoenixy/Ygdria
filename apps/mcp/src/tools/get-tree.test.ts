import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index.js";

test("tree navigation exposes only placement-ID based tools", async () => {
  const server = createServer({ baseUrl: "http://127.0.0.1:4318" });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("get_tree"));
    for (const name of ["list_tree_roots", "get_tree_node", "list_tree_children", "get_tree_subtree", "resolve_tree_nodes"]) {
      assert.ok(names.includes(name));
    }
  } finally {
    await client.close();
    await server.close();
  }
});
