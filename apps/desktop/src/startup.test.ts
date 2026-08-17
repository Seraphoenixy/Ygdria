import { expect, it, vi } from "vitest";
import { deferQuitOnce, isAddressInUseError, onceAsync, startupFailureDialog } from "./startup";

it("recognizes direct and wrapped address-in-use errors", () => {
  expect(isAddressInUseError({ code: "EADDRINUSE" })).toBe(true);
  expect(isAddressInUseError({ cause: { code: "EADDRINUSE" } })).toBe(true);
  expect(isAddressInUseError(new Error("other failure"))).toBe(false);
});

it("explains that the fixed local port must be released", () => {
  expect(startupFailureDialog({ code: "EADDRINUSE" })).toMatchObject({
    title: "Ygdria could not start",
    message: "Port 4318 is already in use.",
  });
});

it("uses a concise fallback for other local-service startup failures", () => {
  expect(startupFailureDialog(new Error("database is unavailable"))).toMatchObject({
    message: "The local Ygdria service could not be started.",
    detail: "database is unavailable",
  });
});

it("runs a close operation only once while callers wait for it", async () => {
  let resolveClose!: () => void;
  const close = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
  const closeOnce = onceAsync(close);
  const first = closeOnce();
  const second = closeOnce();
  expect(close).toHaveBeenCalledTimes(1);
  expect(second).toBe(first);
  resolveClose();
  await expect(first).resolves.toBeUndefined();
});

it("defers the first quit until the close settles, then quits once", async () => {
  let resolveClose!: () => void;
  const close = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
  const quit = vi.fn();
  const state = { quitting: false };

  // Simulates Electron's before-quit: the caller prevents the immediate quit.
  expect(deferQuitOnce(state, close, quit)).toBe(true);
  expect(state.quitting).toBe(true);
  expect(quit).not.toHaveBeenCalled();

  resolveClose();
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
});

it("lets the re-issued quit pass through without closing again", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const quit = vi.fn();
  const state = { quitting: false };

  expect(deferQuitOnce(state, close, quit)).toBe(true);
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  // The second before-quit (from the re-issued app.quit) must not be deferred.
  expect(deferQuitOnce(state, close, quit)).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
});

it("still quits when the close fails", async () => {
  const close = vi.fn().mockRejectedValue(new Error("close failed"));
  const quit = vi.fn();
  const state = { quitting: false };

  expect(deferQuitOnce(state, close, quit)).toBe(true);
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
});

it("passes through without closing when quitting is already in progress", () => {
  // The original bug: before-quit raised the quitting flag before delegating
  // to the handshake, so the guard returned immediately, the local API was
  // never closed, and app.quit() was never re-issued. The flag must only be
  // raised inside deferQuitOnce.
  const close = vi.fn().mockResolvedValue(undefined);
  const quit = vi.fn();
  const state = { quitting: true };

  expect(deferQuitOnce(state, close, quit)).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});
