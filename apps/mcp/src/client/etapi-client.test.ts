import assert from "node:assert/strict";
import test from "node:test";
import { EtapiClient, EtapiError, EtapiNetworkError } from "./etapi-client.js";

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}

test("search uses local ETAPI headers without credentials and filters protected results", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Response.json({
        items: [
          {
            id: "visible",
            title: "Visible",
            snippet: "text",
            updatedAt: "2026-01-01",
            tags: ["tag"],
          },
          { id: "hidden", title: "Hidden", isProtected: true },
        ],
      });
    }),
  });

  const result = await client.searchNotes("a query");

  assert.equal(
    capturedUrl,
    "http://127.0.0.1:4318/etapi/search?q=a+query&includeArchived=false",
  );
  assert.equal(
    (capturedInit.headers as Record<string, string>).Authorization,
    undefined,
  );
  assert.equal(
    (capturedInit.headers as Record<string, string>)[
      "X-Ygdria-External-Access"
    ],
    "1",
  );
  assert.equal(
    (capturedInit.headers as Record<string, string>)["X-Ygdria-Local-Token"],
    undefined,
  );
  assert.deepEqual(
    result.items.map((item) => item.noteId),
    ["visible"],
  );
});

test("search normalizes HTML snippets to plain text", async () => {
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch(() =>
      Response.json({
        items: [
          { noteId: "note-1", snippet: "A <mark>match</mark> &amp; more" },
        ],
      }),
    ),
  });

  const result = await client.searchNotes("match");
  assert.deepEqual(result.items, [
    {
      noteId: "note-1",
      title: "",
      snippet: "A match & more",
      updatedAt: "",
      tags: [],
    },
  ]);
});

test("searchByTag uses the ETAPI tag query and listTags uses its dedicated endpoint", async () => {
  const urls: string[] = [];
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch((url) => {
      urls.push(url);
      return Response.json({ items: [] });
    }),
  });

  await client.searchByTag("project", true);
  await client.listTags();
  assert.deepEqual(urls, [
    "http://127.0.0.1:4318/etapi/search?tag=project&includeArchived=true",
    "http://127.0.0.1:4318/etapi/tags",
  ]);
});

test("searches can be scoped to a placement subtree", async () => {
  const urls: string[] = [];
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch((url) => {
      urls.push(url);
      return Response.json({
        items: [{ noteId: "note-1", matchedPlacementIds: ["placement-2"] }],
      });
    }),
  });

  const result = await client.searchNotes("needle", false, "placement-1");
  await client.searchByTag("project", false, "placement-1");
  assert.deepEqual(urls, [
    "http://127.0.0.1:4318/etapi/search?q=needle&placementId=placement-1&includeArchived=false",
    "http://127.0.0.1:4318/etapi/search?tag=project&placementId=placement-1&includeArchived=false",
  ]);
  assert.deepEqual(result.items[0]?.matchedPlacementIds, ["placement-2"]);
});

test("replaceContent sends markdown and If-Match", async () => {
  let capturedInit: RequestInit = {};
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch((_url, init) => {
      capturedInit = init;
      return new Response(null, { status: 204 });
    }),
  });

  await client.replaceContent("note/id", 7, "# New body");

  const headers = capturedInit.headers as Record<string, string>;
  assert.equal(capturedInit.method, "PUT");
  assert.equal(headers["If-Match"], "7");
  assert.equal(headers["Content-Type"], "text/markdown; charset=utf-8");
  assert.equal(capturedInit.body, "# New body");
});

test("editContent sends atomic literal edits as JSON", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Response.json({ id: "note-1", version: 8 });
    }),
  });

  await client.editContent("note/id", {
    expectedVersion: 7,
    edits: [{ oldText: "old", newText: "new", expectedMatches: 1 }],
    dryRun: true,
  });

  assert.equal(
    capturedUrl,
    "http://127.0.0.1:4318/etapi/notes/note%2Fid/content",
  );
  assert.equal(capturedInit.method, "PATCH");
  assert.equal(
    (capturedInit.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  assert.deepEqual(JSON.parse(String(capturedInit.body)), {
    expectedVersion: 7,
    edits: [{ oldText: "old", newText: "new", expectedMatches: 1 }],
    dryRun: true,
  });
});

test("createNote never retries a network failure", async () => {
  let calls = 0;
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch(() => {
      calls += 1;
      throw new TypeError("connection reset");
    }),
  });

  await assert.rejects(
    client.createNote({ title: "Maybe created", content: "body" }),
    EtapiNetworkError,
  );
  assert.equal(calls, 1);
});

test("HTTP errors are mapped without retrying", async () => {
  let calls = 0;
  const client = new EtapiClient({
    baseUrl: "http://127.0.0.1:4318",
    fetchImpl: mockFetch(() => {
      calls += 1;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }),
  });

  await assert.rejects(
    client.getTreeRoots(),
    (error: unknown) =>
      error instanceof EtapiError &&
      error.status === 401 &&
      error.message.includes("Enable AI and external access"),
  );
  assert.equal(calls, 1);
});
