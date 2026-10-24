import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EtapiAccess } from "./etapi-access.js";

describe("local external access preference", () => {
  it("starts disabled and persists both switch states across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ygdria-access-"));
    const file = join(dir, "access.json");
    try {
      const access = new EtapiAccess(file);
      expect(access.getState()).toEqual({ enabled: false });
      access.setEnabled(true);
      expect(new EtapiAccess(file).getState()).toEqual({ enabled: true });
      access.setEnabled(false);
      expect(new EtapiAccess(file).getState()).toEqual({ enabled: false });
      writeFileSync(file, "invalid");
      expect(new EtapiAccess(file).getState()).toEqual({ enabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps access off when saving the preference fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "ygdria-access-"));
    const file = join(dir, "directory");
    mkdirSync(file);
    try {
      const access = new EtapiAccess(file);
      expect(() => access.setEnabled(true)).toThrow();
      expect(access.getState()).toEqual({ enabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
