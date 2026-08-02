import { afterEach, describe, expect, it, vi } from "vitest";
import { Devices, DeviceError } from "./devices.js";
import { DEVICE_TOKEN_IDLE_TIMEOUT_MS } from "@ygdria/shared";

describe("Devices", () => {
  it("rejects bootstrap pairing token after first device is paired", () => {
    const devices = new Devices();
    const { pairingToken } = devices.createBootstrapPairingToken();
    devices.pair(pairingToken, "桌面端");
    expect(() => devices.createBootstrapPairingToken()).toThrow(DeviceError);
  });

  it("issues a device credential that verifies correctly", () => {
    const devices = new Devices();
    const { pairingToken } = devices.createBootstrapPairingToken();
    const { deviceId, deviceToken } = devices.pair(pairingToken, "桌面端");
    const device = devices.verify(deviceToken);
    expect(device).toBeDefined();
    expect(device!.id).toBe(deviceId);
    expect(device!.label).toBe("桌面端");
  });

  it("rejects an unknown device token", () => {
    const devices = new Devices();
    expect(devices.verify("not-a-real-token")).toBeNull();
  });

  it("invalidates a pairing token after single use", () => {
    const devices = new Devices();
    const { pairingToken } = devices.createBootstrapPairingToken();
    devices.pair(pairingToken, "桌面端");
    expect(() => devices.pair(pairingToken, "第二台")).toThrow(DeviceError);
  });

  it("rejects pairing with empty label", () => {
    const devices = new Devices();
    const { pairingToken } = devices.createBootstrapPairingToken();
    expect(() => devices.pair(pairingToken, "")).toThrow(DeviceError);
    expect(() => devices.pair(pairingToken, "   ")).toThrow(DeviceError);
  });

  it("lets a paired device issue a new pairing token for mobile", () => {
    const devices = new Devices();
    const { pairingToken: bootstrap } = devices.createBootstrapPairingToken();
    const { deviceId: desktopId, deviceToken: desktopToken } = devices.pair(bootstrap, "桌面端");
    const { pairingToken: mobileToken } = devices.createPairingToken(desktopId);
    const { deviceId: mobileId, deviceToken: mobileTokenCred } = devices.pair(mobileToken, "iPhone");
    expect(mobileId).not.toBe(desktopId);
    expect(devices.verify(desktopToken)).toBeDefined();
    expect(devices.verify(mobileTokenCred)).toBeDefined();
    expect(devices.list()).toHaveLength(2);
  });

  it("revokes a device and invalidates its token immediately", () => {
    const devices = new Devices();
    const { pairingToken } = devices.createBootstrapPairingToken();
    const { deviceId, deviceToken } = devices.pair(pairingToken, "桌面端");
    devices.revoke(deviceId);
    expect(devices.verify(deviceToken)).toBeNull();
    expect(devices.get(deviceId)).toBeUndefined();
    expect(devices.list()).toHaveLength(0);
  });

  it("revokeAllExcept keeps only the specified device", () => {
    const devices = new Devices();
    const { pairingToken: b1 } = devices.createBootstrapPairingToken();
    const { deviceId: d1, deviceToken: t1 } = devices.pair(b1, "桌面端");
    const { pairingToken: p2 } = devices.createPairingToken(d1);
    const { deviceId: d2, deviceToken: t2 } = devices.pair(p2, "iPhone");
    const { pairingToken: p3 } = devices.createPairingToken(d1);
    const { deviceId: d3, deviceToken: t3 } = devices.pair(p3, "iPad");

    const revoked = devices.revokeAllExcept(d1);
    expect(revoked).toBe(2);
    expect(devices.verify(t1)).toBeDefined();
    expect(devices.verify(t2)).toBeNull();
    expect(devices.verify(t3)).toBeNull();
    expect(devices.list()).toHaveLength(1);
    expect(devices.list()[0].id).toBe(d1);
  });

  it("list() never exposes token hashes", () => {
    const devices = new Devices();
    const { pairingToken } = devices.createBootstrapPairingToken();
    devices.pair(pairingToken, "桌面端");
    const json = JSON.stringify(devices.list());
    expect(json).not.toContain("tokenHash");
    expect(json).not.toContain("token_hash");
  });

  describe("idle timeout", () => {
    afterEach(() => vi.useRealTimers());

    it("refreshes lastActiveAt on every authenticated request", () => {
      const devices = new Devices();
      const { pairingToken } = devices.createBootstrapPairingToken();
      const { deviceToken } = devices.pair(pairingToken, "桌面端");
      const base = Date.now();
      vi.setSystemTime(base);
      devices.verify(deviceToken);
      vi.setSystemTime(base + 1000);
      const device = devices.verify(deviceToken);
      expect(device).toBeDefined();
      expect(device!.lastActiveAt).toBe(base + 1000);
    });

    it("rejects and deletes a token idle longer than 5 days", () => {
      const devices = new Devices();
      const { pairingToken } = devices.createBootstrapPairingToken();
      const { deviceId, deviceToken } = devices.pair(pairingToken, "桌面端");
      // Advance just past the fixed 5-day idle window.
      vi.setSystemTime(Date.now() + DEVICE_TOKEN_IDLE_TIMEOUT_MS + 1);
      expect(devices.verify(deviceToken)).toBeNull();
      // The record was reclaimed, not just rejected.
      expect(devices.get(deviceId)).toBeUndefined();
      expect(devices.list()).toHaveLength(0);
    });

    it("keeps a token valid just under the 5-day idle window", () => {
      const devices = new Devices();
      const { pairingToken } = devices.createBootstrapPairingToken();
      const { deviceToken } = devices.pair(pairingToken, "桌面端");
      vi.setSystemTime(Date.now() + DEVICE_TOKEN_IDLE_TIMEOUT_MS - 1);
      expect(devices.verify(deviceToken)).toBeDefined();
    });
  });

  it("revokeAll invalidates every device including the caller", () => {
    const devices = new Devices();
    const { pairingToken: b1 } = devices.createBootstrapPairingToken();
    const { deviceId: d1, deviceToken: t1 } = devices.pair(b1, "桌面端");
    const { pairingToken: p2 } = devices.createPairingToken(d1);
    const { deviceToken: t2 } = devices.pair(p2, "手机");
    const revoked = devices.revokeAll();
    expect(revoked).toBe(2);
    expect(devices.verify(t1)).toBeNull();
    expect(devices.verify(t2)).toBeNull();
    expect(devices.list()).toHaveLength(0);
  });
});
