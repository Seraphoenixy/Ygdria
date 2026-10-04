import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  remote: null as any,
  values: [] as any[],
  index: 0,
  client: null as any,
}));
vi.mock("react", () => ({
  useCallback: (fn: any) => fn,
  useEffect: () => {},
  useRef: (value: any) => ({ current: value }),
  useState: (initial: any) => {
    const index = state.index++;
    state.values[index] =
      index === 0 ? state.remote : typeof initial === "function" ? initial() : initial;
    return [
      state.values[index],
      (next: any) => {
        state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
      },
    ];
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
import { useSync } from "./useSync.js";

function run() {
  return new Promise<void>((resolve) => {
    const hook = useSync({
      client: state.client,
      locale: "zh-CN",
      refreshTree: vi.fn(),
      openSettings: vi.fn(),
      deviceAccess: "ready",
      session: {} as any,
      setProtectedSession: vi.fn(),
      showToast: () => resolve(),
      isDesktopApp: false,
      editing: false,
    });
    hook.syncNow();
  });
}
beforeEach(() => {
  state.index = 0;
  state.values = [];
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  state.remote = {
    peerId: () => "remote",
    advanceSyncCursor: vi.fn().mockResolvedValue({}),
    syncChanges: vi.fn().mockResolvedValue({ changes: [], cursor: 9, hasMore: false }),
    pushSyncChanges: vi
      .fn()
      .mockResolvedValue({
        applied: 0,
        rejected: [{ entityType: "note", entityId: "n", localUpdatedAt: 20, localVersion: 2 }],
      }),
  };
  state.client = {
    getSyncCursor: vi
      .fn()
      .mockImplementation((peer: string) =>
        Promise.resolve({ advancedAt: 1, lastAdvanceId: peer.startsWith("in:") ? 9 : 0 }),
      ),
    syncChanges: vi.fn().mockResolvedValue({ changes: [], cursor: 0, hasMore: false }),
    advanceSyncCursor: vi.fn().mockResolvedValue({}),
    getNote: vi.fn().mockResolvedValue({ title: "Mine", content: {}, updatedAt: 10, version: 1 }),
  };
});

describe("sync failure recovery", () => {
  it("persists a rejected edit before a later download failure", async () => {
    state.client.syncChanges.mockResolvedValueOnce({
      changes: [{ entityType: "note", changeKind: "updated", entityId: "n", data: { id: "n" } }],
      cursor: 1,
      hasMore: false,
    });
    const response = await state.remote.pushSyncChanges();
    state.remote.pushSyncChanges.mockImplementation(
      async (_changes: any, _origin: any, _peer: any, persist: any) => {
        await persist(response.rejected);
        return response;
      },
    );
    state.remote.syncChanges.mockRejectedValueOnce(new Error("offline"));
    await run();
    const stored = JSON.parse(window.localStorage.getItem("ygdria.sync.conflicts") ?? "{}");
    expect(stored.remote?.[0]?.noteId).toBe("n");
  });

  it("reconfirms an already applied cursor even if the next pull is empty", async () => {
    await run();
    expect(state.remote.advanceSyncCursor).toHaveBeenCalledWith(expect.any(String), 9);
  });
  it("restarts an expired snapshot from page zero with a new session", async () => {
    state.client.getSyncCursor.mockResolvedValueOnce({ advancedAt: null, lastAdvanceId: 0 });
    state.client.pushSyncChanges = vi.fn().mockResolvedValue({ applied: 1, rejected: [] });
    state.remote.syncSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [{ entityType: "setting", changeKind: "updated", data: {} }],
        cursor: 1,
        maxChangeId: 9,
        hasMore: true,
      })
      .mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "SYNC_SNAPSHOT_EXPIRED" }))
      .mockResolvedValueOnce({ changes: [], cursor: 0, maxChangeId: 10, hasMore: false });
    await run();
    const calls = state.remote.syncSnapshot.mock.calls;
    expect(calls.map((args: any[]) => args[0])).toEqual([0, 1, 0]);
    expect(calls[0][4]).not.toBe(calls[2][4]);
    expect(state.remote.advanceSyncCursor).toHaveBeenCalledWith(
      expect.any(String),
      10,
      calls[2][4],
    );
  });
});
