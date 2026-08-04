import { describe, it, expect } from "vitest";
import { mapWithConcurrency, protectedSessionSyncAction, shouldAutoSync, type AutoSyncOptions } from "./useSync.js";

function base(): AutoSyncOptions {
  return {
    state: "pending",
    editing: false,
    syncing: false,
    syncConflictsLen: 0,
    remoteReauthRequired: false,
    remoteClientAvailable: true,
    isDesktop: true,
    syncLocked: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shouldAutoSync", () => {
  it("returns true when all preconditions are met", () => {
    expect(shouldAutoSync(base())).toBe(true);
  });

  // --- isDesktop guard ---
  it("returns false when isDesktop is false (non-desktop platforms)", () => {
    expect(shouldAutoSync({ ...base(), isDesktop: false })).toBe(false);
  });

  // --- editing guard ---
  it("returns false when editing is true", () => {
    expect(shouldAutoSync({ ...base(), editing: true })).toBe(false);
  });

  // --- syncing guard (concurrent sync protection) ---
  it("returns false when syncing is true", () => {
    expect(shouldAutoSync({ ...base(), syncing: true })).toBe(false);
  });

  // --- syncLocked guard (ref-based concurrent sync protection) ---
  it("returns false when syncLocked is true", () => {
    expect(shouldAutoSync({ ...base(), syncLocked: true })).toBe(false);
  });

  // --- conflict guard ---
  it("returns false when there are pending sync conflicts", () => {
    expect(shouldAutoSync({ ...base(), syncConflictsLen: 1 })).toBe(false);
    expect(shouldAutoSync({ ...base(), syncConflictsLen: 3 })).toBe(false);
  });

  // --- reauthRequired guard ---
  it("returns false when remote re-authentication is required", () => {
    expect(shouldAutoSync({ ...base(), remoteReauthRequired: true })).toBe(false);
  });

  // --- remoteClientAvailable guard ---
  it("returns false when remote client is not available", () => {
    expect(shouldAutoSync({ ...base(), remoteClientAvailable: false })).toBe(false);
  });

  // --- state guard ---
  it("returns false when state is 'synced'", () => {
    expect(shouldAutoSync({ ...base(), state: "synced" })).toBe(false);
  });

  it("returns false when state is 'unconfigured'", () => {
    expect(shouldAutoSync({ ...base(), state: "unconfigured" })).toBe(false);
  });

  // --- Combination tests ---
  it("returns false when multiple conditions fail (editing + conflicts)", () => {
    expect(
      shouldAutoSync({ ...base(), editing: true, syncConflictsLen: 2 }),
    ).toBe(false);
  });

  it("returns false when non-desktop and syncing", () => {
    expect(
      shouldAutoSync({ ...base(), isDesktop: false, syncing: true }),
    ).toBe(false);
  });

  it("returns false when syncLocked and state is synced", () => {
    expect(
      shouldAutoSync({ ...base(), syncLocked: true, state: "synced" }),
    ).toBe(false);
  });

  // --- Edge cases ---
  it("returns false when syncConflictsLen is 0 but reauth is required", () => {
    expect(
      shouldAutoSync({ ...base(), syncConflictsLen: 0, remoteReauthRequired: true }),
    ).toBe(false);
  });

  it("returns false when all good except isDesktop", () => {
    expect(shouldAutoSync({ ...base(), isDesktop: false })).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  it("caps concurrent work while preserving input order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });
});

describe("protectedSessionSyncAction", () => {
  const none = { configured: false, salt: null, verifier: null, timeoutMs: 600_000 };
  const first = { configured: true, salt: "salt-1", verifier: "verifier-1", timeoutMs: 600_000 };
  const second = { configured: true, salt: "salt-2", verifier: "verifier-2", timeoutMs: 600_000 };

  it("seeds an unconfigured server from the first configured device", () => {
    expect(protectedSessionSyncAction(first, none)).toBe("publish-local");
  });

  it("adopts the server record on a new or mismatched device", () => {
    expect(protectedSessionSyncAction(none, first)).toBe("adopt-remote");
    expect(protectedSessionSyncAction(second, first)).toBe("adopt-remote");
  });

  it("does not write a key record when neither side is configured", () => {
    expect(protectedSessionSyncAction(none, none)).toBe("unconfigured");
  });
});
