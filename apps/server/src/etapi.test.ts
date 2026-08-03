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

    expect((await app.inject({ url: "/etapi/tree", headers })).statusCode).toBe(200);
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

    const tree = (await app.inject({ url: "/etapi/tree", headers })).json().items;
    expect(
      tree.find((item: any) => item.noteId === child.id).parentPlacementId,
    ).toBe(parent.placements[0].placementId);

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

    const session = await issue(["notes:read"]);
    const headers = { authorization: `Bearer ${session.accessToken}` };
    const tree = (await app.inject({ url: "/etapi/tree", headers })).json().items;
    const protectedNode = tree.find((item: any) => item.noteId === note.id);
    expect(protectedNode).toMatchObject({
      title: "",
      properties: { tags: [] },
      isProtected: true,
    });
    expect(
      (await app.inject({ url: `/etapi/notes/${note.id}`, headers })).statusCode,
    ).toBe(409);
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
          url: "/etapi/tree",
          headers: { authorization: `Bearer ${session.accessToken}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});
