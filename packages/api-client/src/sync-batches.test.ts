import { describe, it, expect } from "vitest";
import { pushSyncBatches } from "./sync-batches.js";

describe("hydrated sync batches", () => {
  it("bounds UTF-8 request bytes and preserves all 500 entities and conflicts", async () => {
    const changes = Array.from({ length: 500 }, (_, id) => ({
      id,
      content: "汉".repeat(12 * 1024),
    }));
    const received: number[] = [];
    let calls = 0;
    const result = await pushSyncBatches(
      changes,
      async (batch) => {
        expect(
          new TextEncoder().encode(JSON.stringify({ changes: batch, peerId: "peer" })).length,
        ).toBeLessThanOrEqual(4 * 1024 * 1024);
        received.push(...batch.map((c) => c.id));
        calls++;
        return { applied: batch.length - 1, rejected: [batch[0].id] };
      },
      "peer",
    );
    expect(received).toEqual(changes.map((c) => c.id));
    expect(calls).toBeGreaterThan(1);
    expect(result.applied + result.rejected.length).toBe(500);
  });

  it("shrinks rejected requests without reordering or retrying accepted batches", async () => {
    const received: number[] = [];
    await pushSyncBatches([1, 2, 3, 4], async (batch) => {
      if (batch.length > 1) throw Object.assign(new Error("proxy limit"), { statusCode: 413 });
      received.push(...batch);
      return { applied: 1, rejected: [] };
    });
    expect(received).toEqual([1, 2, 3, 4]);
  });

  it("propagates transport failures and reports an indivisible oversized entity", async () => {
    await expect(
      pushSyncBatches([1], async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await expect(
      pushSyncBatches(["a".repeat(16 * 1024 * 1024)], async () => ({ applied: 1, rejected: [] })),
    ).rejects.toThrow("Single sync entity");
  });
});

it("reports accepted sub-batch conflicts before a later sub-batch fails", async () => {
  const persisted: number[] = [];
  const changes = ["x".repeat(3 * 1024 * 1024), "y".repeat(3 * 1024 * 1024)];
  let calls = 0;
  await expect(
    pushSyncBatches(
      changes,
      async () => {
        if (++calls === 2) throw new Error("offline");
        return { applied: 0, rejected: [1] };
      },
      undefined,
      async (response) => {
        persisted.push(...response.rejected);
      },
    ),
  ).rejects.toThrow("offline");
  expect(persisted).toEqual([1]);
});
