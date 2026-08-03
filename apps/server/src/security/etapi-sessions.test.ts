import { describe, expect, it } from "vitest";
import { EtapiSessions } from "./etapi-sessions.js";

describe("EtapiSessions", () => {
  it("stores no reusable token in its public session list and supports revocation", () => {
    const sessions = new EtapiSessions(() => 1_000);
    const issued = sessions.issue({
      label: "AI assistant",
      scopes: ["notes:read"],
      ttlSeconds: 60,
    });

    expect(issued.accessToken).toMatch(/^yg_etapi_/);
    expect(sessions.verify(issued.accessToken)?.id).toBe(issued.id);
    expect(JSON.stringify(sessions.list())).not.toContain(issued.accessToken);
    expect(sessions.revoke(issued.id)).toBe(true);
    expect(sessions.verify(issued.accessToken)).toBeNull();
  });

  it("expires credentials at the exact expiry boundary", () => {
    let now = 10_000;
    const sessions = new EtapiSessions(() => now);
    const issued = sessions.issue({
      label: "Reader",
      scopes: ["notes:read"],
      ttlSeconds: 60,
    });

    now = issued.expiresAt - 1;
    expect(sessions.verify(issued.accessToken)).not.toBeNull();
    now = issued.expiresAt;
    expect(sessions.verify(issued.accessToken)).toBeNull();
    expect(sessions.list()).toEqual([]);
  });
});
