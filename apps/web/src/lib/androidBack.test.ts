import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  backListener: undefined as undefined | (() => void),
  minimizeApp: vi.fn(),
  addListener: vi.fn(async (_event: string, listener: () => void) => {
    native.backListener = listener;
    return { remove: async () => undefined };
  }),
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: native.addListener, minimizeApp: native.minimizeApp },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

import { registerAndroidBackHandler } from "./androidBack";

describe("Android back dispatcher", () => {
  const unregister: Array<() => void> = [];

  afterEach(() => {
    while (unregister.length) unregister.pop()!();
    native.minimizeApp.mockClear();
    native.addListener.mockClear();
  });

  it("installs the native back listener once and runs the newest handler first", () => {
    const order: string[] = [];
    unregister.push(registerAndroidBackHandler(() => (order.push("older"), false)));
    unregister.push(registerAndroidBackHandler(() => (order.push("newer"), true)));

    expect(native.addListener).toHaveBeenCalledTimes(1);
    expect(native.addListener).toHaveBeenCalledWith("backButton", expect.any(Function));

    native.backListener!();
    expect(order).toEqual(["newer"]);
    expect(native.minimizeApp).not.toHaveBeenCalled();
  });

  it("minimizes the app when no registered handler claims the press", () => {
    unregister.push(registerAndroidBackHandler(() => false));

    native.backListener!();
    expect(native.minimizeApp).toHaveBeenCalledTimes(1);
  });

  it("stops dispatching after a handler is unregistered", () => {
    const handled = vi.fn(() => true);
    unregister.push(registerAndroidBackHandler(handled));
    unregister.pop()!();

    native.backListener!();
    expect(handled).not.toHaveBeenCalled();
    expect(native.minimizeApp).toHaveBeenCalledTimes(1);
  });
});
