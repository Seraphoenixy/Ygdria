import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAttachmentRoutes } from "./attachments.js";

function createApp() {
  const attachments = {
    clearUnusedAttachments: vi.fn(() => ({ count: 0, attachmentStorageKeys: [] })),
    cleanOrphanFiles: vi.fn(async () => ({ deletedKeys: [] })),
    runStorageCleanup: vi.fn(async () => ({ deletedKeys: [] })),
  };
  const app = Fastify();
  registerAttachmentRoutes(app, {
    attachments: attachments as any,
    sqlite: {} as any,
    attachmentRoot: "",
    recordOutbound: () => true,
  });
  return { app, attachments };
}

describe("unused attachment cleanup", () => {
  it("skips the orphan-file scan for scheduled retention cleanup", async () => {
    const { app, attachments } = createApp();
    try {
      const response = await app.inject({ method: "DELETE", url: "/api/v1/attachments/unused?before=123&scanOrphans=0" });
      expect(response.statusCode).toBe(200);
      expect(attachments.clearUnusedAttachments).toHaveBeenCalledWith(123);
      expect(attachments.runStorageCleanup).toHaveBeenCalledOnce();
      expect(attachments.cleanOrphanFiles).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps a full orphan-file scan for explicit cleanup", async () => {
    const { app, attachments } = createApp();
    try {
      const response = await app.inject({ method: "DELETE", url: "/api/v1/attachments/unused" });
      expect(response.statusCode).toBe(200);
      expect(attachments.cleanOrphanFiles).toHaveBeenCalledOnce();
      expect(attachments.runStorageCleanup).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
