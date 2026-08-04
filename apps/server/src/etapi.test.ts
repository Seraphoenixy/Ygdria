import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("AI-oriented ETAPI", () => {
  let app: ReturnType<typeof buildApp>;
  let deviceToken: string;

  beforeAll(async () => {
    app = buildApp({ databaseUrl: ":memory:", enableDeviceAuth: true, enableEtapi: true });
    const initialized = await app.inject({
      method: "POST",
      url: "/api/v1/devices/initialize",
      payload: {
        accessSalt: "test-access-salt",
        srpSalt: "test-srp-salt",
        verifier: "test-verifier",
        fileSalt: "test-file-salt",
        fileVerifier: "test-file-verifier",
        label: "test device",
      },
    });
    expect(initialized.statusCode).toBe(200);
    deviceToken = initialized.json().deviceToken;
  });

  afterAll(async () => app.close());

  async function issue(scopes: Array<"notes:read" | "notes:write">) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/etapi/sessions",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { label: "test AI", scopes, ttlSeconds: 300 },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: string;
      accessToken: string;
      scopes: string[];
      expiresAt: number;
    };
  }

  it("limits a short-lived token to ETAPI and its declared scopes", async () => {
    const session = await issue(["notes:read"]);
    const headers = { authorization: `Bearer ${session.accessToken}` };

    expect((await app.inject({ url: "/etapi/tree/roots", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/tree", headers })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/etapi/notes",
          headers,
          payload: { title: "Denied" },
        })
      ).statusCode,
    ).toBe(403);

    const writer = await issue(["notes:write"]);
    const writerHeaders = { authorization: `Bearer ${writer.accessToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/etapi/notes",
      headers: writerHeaders,
      payload: { title: "Write only", content: "private input" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      id: expect.any(String),
      version: 1,
      updatedAt: expect.any(String),
    });
    expect(
      (
        await app.inject({
          url: `/etapi/notes/${created.json().id}`,
          headers: writerHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/etapi/notes/${created.json().id}/content`,
          headers: writerHeaders,
          payload: {
            expectedVersion: 1,
            edits: [{ oldText: "private input", newText: "changed" }],
            dryRun: true,
          },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("accepts an ETAPI token lifetime of up to eight hours", async () => {
    const before = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/etapi/sessions",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { label: "long-running AI", scopes: ["notes:read"], ttlSeconds: 8 * 60 * 60 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().expiresAt).toBeGreaterThanOrEqual(before + 8 * 60 * 60 * 1000);
  });

  it("reads hierarchy, content and tags and edits with optimistic locking", async () => {
    const session = await issue(["notes:read", "notes:write"]);
    const headers = { authorization: `Bearer ${session.accessToken}` };
    const parentResponse = await app.inject({
      method: "POST",
      url: "/etapi/notes",
      headers,
      payload: {
        title: "AI parent",
        content: "# Parent content",
        tags: ["project"],
      },
    });
    expect(parentResponse.statusCode).toBe(201);
    const parent = parentResponse.json();
    expect(parent.content).toContain("Parent content");
    expect(parent.properties.tags).toEqual(["project"]);

    const childResponse = await app.inject({
      method: "POST",
      url: "/etapi/notes",
      headers,
      payload: {
        title: "AI child",
        parentPlacementId: parent.placements[0].placementId,
        content: "Initial",
        tags: ["draft"],
      },
    });
    expect(childResponse.statusCode).toBe(201);
    const child = childResponse.json();

    const parentPlacementId = parent.placements[0].placementId;
    const tree = (await app.inject({ url: `/etapi/tree/nodes/${parentPlacementId}/subtree?maxDepth=2`, headers })).json().items;
    expect(tree.map((item: any) => item.noteId)).toEqual([parent.id, child.id]);
    expect(
      tree.find((item: any) => item.noteId === child.id).parentPlacementId,
    ).toBe(parentPlacementId);
    const children = (await app.inject({ url: `/etapi/tree/nodes/${parentPlacementId}/children?limit=1`, headers })).json();
    expect(children.items).toHaveLength(1);
    expect(children.items[0].noteId).toBe(child.id);
    const resolved = (await app.inject({ url: "/etapi/tree/resolve?query=AI%20parent", headers })).json().items;
    expect(resolved).toEqual(expect.arrayContaining([expect.objectContaining({ placementId: parentPlacementId })]));

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/etapi/notes/${child.id}`,
      headers,
      payload: {
        expectedVersion: child.version,
        title: "AI child updated",
        content: "## Updated content",
        tags: ["reviewed", "project"],
      },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = updatedResponse.json();
    expect(updated.title).toBe("AI child updated");
    expect(updated.content).toContain("Updated content");
    expect(updated.properties.tags).toEqual(["reviewed", "project"]);

    const stale = await app.inject({
      method: "PATCH",
      url: `/etapi/notes/${child.id}`,
      headers,
      payload: { expectedVersion: child.version, title: "stale writer" },
    });
    expect(stale.statusCode).toBe(409);

    const byTag = (
      await app.inject({ url: "/etapi/search?tag=reviewed", headers })
    ).json().items;
    expect(byTag.some((item: any) => item.noteId === child.id)).toBe(true);

    const code = (
      await app.inject({
        method: "POST",
        url: "/etapi/notes",
        headers,
        payload: { title: "Source", type: "code", content: "const answer = 42;" },
      })
    ).json();
    const codeJson = await app.inject({
      url: `/etapi/notes/${code.id}/content?format=json`,
      headers,
    });
    expect(codeJson.headers["content-type"]).toContain("application/json");
    expect(codeJson.json()).toBe("const answer = 42;");
  });

  it("keeps protected notes redacted while preserving their tree position", async () => {
    const deviceHeaders = { authorization: `Bearer ${deviceToken}` };
    const note = (
      await app.inject({
        method: "POST",
        url: "/api/v1/notes",
        headers: deviceHeaders,
        payload: { title: "Secret title", tags: ["secret-tag"] },
      })
    ).json();
    const protectedResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/notes/${note.id}/protected`,
      headers: deviceHeaders,
      payload: { protected: true, contentCiphertext: "v1.test-ciphertext" },
    });
    expect(protectedResponse.statusCode).toBe(200);
    const protectedPlacementId = (await app.inject({
      url: "/api/v1/tree",
      headers: deviceHeaders,
    })).json().find((item: any) => item.noteId === note.id).placementId;

    const session = await issue(["notes:read"]);
    const headers = { authorization: `Bearer ${session.accessToken}` };
    const protectedNode = (await app.inject({ url: `/etapi/tree/nodes/${protectedPlacementId}`, headers })).json();
    expect(protectedNode).toMatchObject({ title: "", isProtected: true });
    expect(
      (await app.inject({ url: `/etapi/notes/${note.id}`, headers })).statusCode,
    ).toBe(409);
  });

  it("searches a placement subtree and applies atomic literal content edits", async () => {
    const session = await issue(["notes:read", "notes:write"]);
    const headers = { authorization: `Bearer ${session.accessToken}` };
    const root = (await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: { title: "Scoped root", content: "root body" },
    })).json();
    const child = (await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: {
        title: "Scoped child", parentPlacementId: root.placements[0].placementId,
        content: "unique subtree needle\nreplace this", tags: ["scoped-tag"],
      },
    })).json();
    await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: { title: "Outside", content: "unique subtree needle", tags: ["scoped-tag"] },
    });

    const scoped = (await app.inject({
      url: `/etapi/search?q=unique%20subtree%20needle&placementId=${root.placements[0].placementId}`,
      headers,
    })).json().items;
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ noteId: child.id, matchedPlacementIds: [child.placements[0].placementId] });
    const scopedTag = (await app.inject({
      url: `/etapi/search?tag=scoped-tag&placementId=${root.placements[0].placementId}`,
      headers,
    })).json().items;
    expect(scopedTag).toHaveLength(1);

    const preview = await app.inject({
      method: "PATCH", url: `/etapi/notes/${child.id}/content`, headers,
      payload: { expectedVersion: child.version, edits: [{ oldText: "replace this", newText: "replaced" }], dryRun: true },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, matches: [1], content: expect.stringContaining("replaced") });
    expect((await app.inject({ url: `/etapi/notes/${child.id}/content`, headers })).body).toContain("replace this");

    const patched = await app.inject({
      method: "PATCH", url: `/etapi/notes/${child.id}/content`, headers,
      payload: { expectedVersion: child.version, edits: [{ oldText: "replace this", newText: "replaced" }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().content).toContain("replaced");
    expect((await app.inject({
      method: "PATCH", url: `/etapi/notes/${child.id}/content`, headers,
      payload: { expectedVersion: patched.json().version, edits: [{ oldText: "missing", newText: "anything" }] },
    })).statusCode).toBe(422);
  });

  it("revokes an ETAPI session immediately", async () => {
    const session = await issue(["notes:read"]);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/etapi/sessions/${session.id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: "/etapi/tree/roots",
          headers: { authorization: `Bearer ${session.accessToken}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});
