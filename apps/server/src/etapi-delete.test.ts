import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ROOT_NOTE_ID } from "@ygdria/shared";
import { buildApp } from "./app.js";

describe("ETAPI recoverable note deletion", () => {
  let app: ReturnType<typeof buildApp>;
  let admin: { authorization: string };
  const headers = { "x-ygdria-external-access": "1" };
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
    admin = { authorization: `Bearer ${initialized.json().deviceToken}` };
    await app.inject({
      method: "PATCH",
      url: "/api/v1/etapi/access",
      headers: admin,
      payload: { enabled: true },
    });
  });
  afterAll(async () => app.close());
  const create = async (title: string, parentPlacementId?: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/etapi/notes",
      headers,
      payload: { title, content: "preserved body", parentPlacementId },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  };
  const remove = (id: string, version: number) =>
    app.inject({
      method: "DELETE",
      url: `/etapi/notes/${id}`,
      headers: { ...headers, "if-match": String(version) },
    });

  it("removes all leaf clones, signals changes, and restores the original content and placements", async () => {
    const note = await create("Delete leaf");
    const folder = await create("Clone folder");
    const clone = await app.inject({
      method: "POST",
      url: "/api/v1/placements",
      headers: admin,
      payload: { noteId: note.id, parentPlacementId: folder.placements[0].placementId },
    });
    expect(clone.statusCode).toBeLessThan(300);
    const original = (await app.inject({ url: `/etapi/notes/${note.id}`, headers })).json();
    expect(original.placements).toHaveLength(2);
    const before = (await app.inject({ url: "/api/v1/tree/version", headers: admin })).json()
      .version;
    const result = await remove(note.id, note.version);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ id: note.id, deleted: true, undoId: expect.any(String) });
    expect((await app.inject({ url: `/etapi/notes/${note.id}`, headers })).statusCode).toBe(404);
    expect((await remove(note.id, note.version)).statusCode).toBe(404);
    expect(
      (await app.inject({ url: "/etapi/search?q=Delete%20leaf", headers })).json().items,
    ).toEqual([]);
    expect(
      (await app.inject({ url: "/api/v1/tree/version", headers: admin })).json().version,
    ).toBeGreaterThan(before);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notes/${note.id}/restore`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(200);
    const restored = (await app.inject({ url: `/etapi/notes/${note.id}`, headers })).json();
    expect(restored.content).toBe(original.content);
    expect(restored.placements).toEqual(original.placements);
  });

  it("rejects missing or stale versions and children under any clone without mutations", async () => {
    const note = await create("Delete guarded");
    expect(
      (await app.inject({ method: "DELETE", url: `/etapi/notes/${note.id}`, headers })).statusCode,
    ).toBe(400);
    expect((await remove(note.id, note.version + 1)).statusCode).toBe(409);
    const folder = await create("Guard clone folder");
    const clone = await app.inject({
      method: "POST",
      url: "/api/v1/placements",
      headers: admin,
      payload: { noteId: note.id, parentPlacementId: folder.placements[0].placementId },
    });
    expect(clone.statusCode).toBeLessThan(300);
    const current = (await app.inject({ url: `/etapi/notes/${note.id}`, headers })).json();
    const secondPlacement = current.placements.find(
      (p: { placementId: string }) => p.placementId !== note.placements[0].placementId,
    );
    const child = await create("Preserve child", secondPlacement.placementId);
    expect((await remove(note.id, note.version)).statusCode).toBe(409);
    expect((await app.inject({ url: `/etapi/notes/${note.id}`, headers })).json()).toEqual(current);
    expect((await app.inject({ url: `/etapi/notes/${child.id}`, headers })).statusCode).toBe(200);
    expect((await remove("does-not-exist", 1)).statusCode).toBe(404);
    expect((await remove(SYSTEM_ROOT_NOTE_ID, 1)).statusCode).toBe(409);
  });

  it("keeps protected notes and enforces the external access switch", async () => {
    const note = await create("Protected deletion target");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/notes/${note.id}/protected`,
          headers: admin,
          payload: { protected: true, contentCiphertext: "v1.test-ciphertext" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await remove(note.id, note.version)).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/v1/notes/${note.id}`, headers: admin })).statusCode).toBe(
      200,
    );
    const ordinary = await create("Switch deletion target");
    await app.inject({
      method: "PATCH",
      url: "/api/v1/etapi/access",
      headers: admin,
      payload: { enabled: false },
    });
    try {
      expect((await remove(ordinary.id, ordinary.version)).statusCode).toBe(403);
      expect(
        (await app.inject({ url: `/api/v1/notes/${ordinary.id}`, headers: admin })).statusCode,
      ).toBe(200);
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/v1/etapi/access",
        headers: admin,
        payload: { enabled: true },
      });
    }
  });
});
