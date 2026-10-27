import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("ETAPI stored images", () => {
  let app: ReturnType<typeof buildApp>;
  let admin: { authorization: string };
  const headers = { "x-ygdria-external-access": "1" };
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=";
  beforeAll(async () => {
    app = buildApp({ databaseUrl: ":memory:", enableDeviceAuth: true, enableEtapi: true });
    const initialized = await app.inject({ method: "POST", url: "/api/v1/devices/initialize", payload: {
      accessSalt: "salt", srpSalt: "salt", verifier: "verifier", fileSalt: "salt", fileVerifier: "verifier", label: "test",
    } });
    admin = { authorization: `Bearer ${initialized.json().deviceToken}` };
    expect((await app.inject({ method: "PATCH", url: "/api/v1/etapi/access", headers: admin, payload: { enabled: true } })).statusCode).toBe(200);
  });
  afterAll(async () => app.close());
  async function create() {
    return (await app.inject({ method: "POST", url: "/etapi/notes", headers, payload: { title: "Image import", content: "original" } })).json();
  }
  it("stores, deduplicates and renders attachment references without changing content on upload", async () => {
    const note = await create();
    const upload = () => app.inject({ method: "POST", url: `/etapi/notes/${note.id}/images`, headers, payload: { filename: "diagram.png", dataBase64: png } });
    const first = await upload();
    expect(first.statusCode).toBe(200);
    const image = first.json();
    expect(image).toMatchObject({ mimeType: "image/png", size: Buffer.from(png, "base64").length });
    expect((await upload()).json().id).toBe(image.id);
    const before = (await app.inject({ url: `/etapi/notes/${note.id}`, headers })).json();
    expect(before.version).toBe(note.version);
    expect(before.content.trim()).toBe("original");
    const saved = await app.inject({ method: "PATCH", url: `/etapi/notes/${note.id}`, headers, payload: { expectedVersion: before.version, content: `original\n\n${image.markdown}` } });
    expect(saved.statusCode).toBe(200);
    const doc = (await app.inject({ url: `/etapi/notes/${note.id}?format=json`, headers })).json();
    expect(JSON.stringify(doc)).toContain(image.url);
    expect(JSON.stringify(doc)).toContain('"image"');
    const downloaded = await app.inject({ url: image.url, headers: admin });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.from(png, "base64"));
  });
  it("rejects malformed bytes, unsupported content, path filenames and invisible notes", async () => {
    const note = await create();
    for (const [filename, dataBase64, status] of [
      ["a.png", "!!!!", 400], ["a.png", "AB==", 400], ["../a.png", png, 400],
      ["a.png", Buffer.from("not an image").toString("base64"), 415],
    ] as const) {
      expect((await app.inject({ method: "POST", url: `/etapi/notes/${note.id}/images`, headers, payload: { filename, dataBase64 } })).statusCode).toBe(status);
    }
    expect((await app.inject({ method: "POST", url: "/etapi/notes/missing/images", headers, payload: { filename: "a.png", dataBase64: png } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/notes/${note.id}/protected`, headers: admin, payload: { protected: true, contentCiphertext: "v1.test-ciphertext" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/etapi/notes/${note.id}/images`, headers, payload: { filename: "a.png", dataBase64: png } })).statusCode).toBe(409);
  });
  it("enforces local access headers and the external-access switch", async () => {
    const note = await create();
    const url = `/etapi/notes/${note.id}/images`;
    const payload = { filename: "a.png", dataBase64: png };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: { ...headers, origin: "https://example.com" }, payload })).statusCode).toBe(403);
    await app.inject({ method: "PATCH", url: "/api/v1/etapi/access", headers: admin, payload: { enabled: false } });
    expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(403);
  });
});

