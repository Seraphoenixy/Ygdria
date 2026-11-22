import assert from "node:assert/strict";
import test from "node:test";
import { treeOverview } from "./convenience.js";
import { EtapiClient, EtapiError } from "../client/etapi-client.js";
import { failure } from "./shared.js";

const node = (id: string, children = false) => ({
  placementId: id,
  hasChildren: children,
});
const defaults = {
  maxDepth: 3,
  maxNodes: 100,
  maxBytes: 200_000,
  maxRequests: 50,
  includeArchived: false,
};
test("overview resumes pages and children without dropping nodes", async () => {
  const client = {
    async getTreeRoots(input: { cursor?: string }) {
      return input.cursor
        ? { items: [node("b")], nextCursor: null }
        : { items: [node("a", true)], nextCursor: "a" };
    },
    async getTreeChildren() {
      return { items: [node("a1")], nextCursor: null };
    },
  };
  const first = await treeOverview(client, { ...defaults, maxNodes: 1 });
  assert.deepEqual(
    first.items.map((n) => n.placementId),
    ["a"],
  );
  assert.ok(first.continuation);
  const second = await treeOverview(client, {
    ...defaults,
    continuation: first.continuation!,
  });
  assert.deepEqual(
    second.items.map((n) => n.placementId),
    ["a1", "b"],
  );
  assert.equal(second.truncated, false);
});
test("overview preserves byte-limited page cursor and reports depth limits", async () => {
  const client = {
    async getTreeRoots(input: { cursor?: string }) {
      return {
        items: input.cursor ? [node("b", true)] : [node("a"), node("b", true)],
        nextCursor: null,
      };
    },
    async getTreeChildren() {
      throw new Error("depth must limit children");
    },
  };
  const first = await treeOverview(client, {
    ...defaults,
    maxDepth: 1,
    maxBytes: 70,
  });
  assert.deepEqual(
    first.items.map((n) => n.placementId),
    ["a"],
  );
  const second = await treeOverview(client, {
    ...defaults,
    maxDepth: 1,
    continuation: first.continuation!,
  });
  assert.deepEqual(
    second.items.map((n) => n.placementId),
    ["b"],
  );
  assert.deepEqual(second.unexpandedPlacementIds, ["b"]);
  assert.equal(second.truncated, true);
});
test("overview bounds requests and rejects incompatible continuation", async () => {
  const client = {
    async getTreeRoots() {
      return { items: [node("a", true)], nextCursor: "a" };
    },
    async getTreeChildren() {
      return { items: [], nextCursor: null };
    },
  };
  const first = await treeOverview(client, { ...defaults, maxRequests: 1 });
  assert.equal(first.requests, 1);
  assert.ok(first.continuation);
  await assert.rejects(
    treeOverview(client, {
      ...defaults,
      includeArchived: true,
      continuation: first.continuation!,
    }),
    /same/,
  );
});
test("disabled server requests can be retried after enabling without restarting MCP", async () => {
  let enabled = false;
  let calls = 0;
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: async (_url, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("x-ygdria-external-access"), "1");
      return enabled
        ? Response.json({ items: [] })
        : Response.json({ error: { message: "disabled" } }, { status: 403 });
    },
  });
  await assert.rejects(client.listTags(), /Enable AI and external access/);
  enabled = true;
  await client.listTags();
  assert.equal(calls, 2);
});

test("idempotent create and append send keys without silently retrying", async () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: "note", version: 1 });
    },
  });
  await client.createNote({
    title: "once",
    content: "",
    idempotencyKey: "create-key",
  });
  await client.operateNote(
    "note",
    { operation: "append", text: "added" },
    "append-key",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers.get("idempotency-key"), "create-key");
  assert.equal(calls[1]!.headers.get("idempotency-key"), "append-key");
  assert.equal("idempotencyKey" in (calls[0]!.body as object), false);
});
test("structured errors retain safe business diagnostics and redact 5xx details", () => {
  const result = failure(
    new EtapiError(422, "patch failed", {
      error: { code: "PatchTargetError", diagnostics: { actualMatches: 2 } },
    }),
  );
  assert.equal(result.content[0]!.type, "text");
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(body.status, 422);
  assert.equal(body.details.error.diagnostics.actualMatches, 2);
  const internal = failure(
    new EtapiError(500, "failed", { secret: "internal" }),
  );
  assert.ok(!JSON.stringify(internal).includes("secret"));
});

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConvenienceTools } from "./convenience.js";

async function invoke(
  client: EtapiClient,
  name: string,
  args: Record<string, unknown>,
) {
  const server = new McpServer({ name: "test", version: "1" });
  registerConvenienceTools(server, client);
  const caller = new McpClient({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await caller.connect(a);
  try {
    const result = await caller.callTool({ name, arguments: args });
    return result.structuredContent as {
      items: Array<Record<string, unknown>>;
      remainingNoteIds: string[];
      unprocessed: unknown[];
    };
  } finally {
    await caller.close();
    await server.close();
  }
}
test("batch reads return partial results and metadata excludes body", async () => {
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: async (url) =>
      String(url).includes("missing")
        ? Response.json({ error: { code: "NotFoundError" } }, { status: 404 })
        : Response.json({
            id: "visible",
            title: "note",
            version: 1,
            content: "private body",
          }),
  });
  const result = await invoke(client, "get_notes", {
    noteIds: ["visible", "missing"],
    view: "metadata",
  });
  assert.equal(result.items[0]!.ok, true);
  assert.equal(result.items[1]!.ok, false);
  assert.ok(!JSON.stringify(result.items[0]).includes("private body"));
});
test("batch reads defer oversized notes without returning unbounded content", async () => {
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: async () =>
      Response.json({ id: "large", version: 1, content: "x".repeat(5000) }),
  });
  const result = await invoke(client, "get_notes", {
    noteIds: ["large", "next"],
    maxBytes: 4096,
  });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.remainingNoteIds, ["large", "next"]);
});
test("batch moves preserve partial success and stop on denied permissions", async () => {
  let calls = 0;
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: async () =>
      ++calls === 1
        ? Response.json({ ok: true })
        : Response.json({ error: { code: "Forbidden" } }, { status: 403 }),
  });
  const result = await invoke(client, "move_placements", {
    moves: ["a", "b", "c"].map((placementId) => ({
      placementId,
      parentPlacementId: "parent",
    })),
  });
  assert.equal(calls, 2);
  assert.equal(result.items[0]!.ok, true);
  assert.equal(result.items[1]!.ok, false);
  assert.equal(result.unprocessed.length, 1);
});
