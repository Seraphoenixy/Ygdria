import { describe, expect, it } from "vitest";
import { PULL_TRIGGER_PX, pullDistance } from "./usePullToRefresh.js";

describe("pull-to-refresh math", () => {
  it("never engages on upward or zero drags", () => {
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(-40)).toBe(0);
  });

  it("applies resistance beyond the initial slack", () => {
    expect(pullDistance(20)).toBe(20);
    expect(pullDistance(60)).toBe(34);
    expect(pullDistance(200)).toBe(83);
  });

  it("caps the rubber band so the indicator stays reachable", () => {
    expect(pullDistance(100_000)).toBe(96);
  });

  it("trigger threshold is below the cap", () => {
    expect(PULL_TRIGGER_PX).toBeLessThan(96);
    expect(pullDistance(140)).toBeGreaterThanOrEqual(PULL_TRIGGER_PX);
  });
});
