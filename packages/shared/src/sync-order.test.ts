import { describe, it, expect } from "vitest";
import { orderSyncChanges } from "./sync-order.js";
const placement = (id: string, parentPlacementId: string | null) => ({
  entityType: "placement",
  entityId: id,
  changeKind: "updated",
  data: { id, parentPlacementId },
});
describe("materialized sync dependency order", () => {
  it("orders notes, ancestors, descendants, and order snapshots without mutating inputs", () => {
    const changes = [
      placement("child", "parent"),
      { entityType: "placement-order", entityId: "parent" },
      placement("parent", "grandparent"),
      { entityType: "note", entityId: "note" },
      placement("grandparent", null),
    ];
    expect(orderSyncChanges(changes).map((c) => c.entityId)).toEqual([
      "note",
      "grandparent",
      "parent",
      "child",
      "parent",
    ]);
    expect(changes[0].entityId).toBe("child");
  });
  it("retains duplicates and permits parents that already exist outside this batch", () => {
    const p = placement("parent", "existing");
    expect(orderSyncChanges([placement("child", "parent"), p, p]).map((c) => c.entityId)).toEqual([
      "parent",
      "parent",
      "child",
    ]);
    expect(orderSyncChanges([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("reports cycles before partial application, while malformed ids can be validated by the receiver", () => {
    expect(() => orderSyncChanges([placement("a", "b"), placement("b", "a")])).toThrow(/cycle/);
    expect(
      orderSyncChanges([
        { entityType: "placement", data: {} },
        { entityType: "placement", changeKind: "deleted", entityId: "old", data: null },
      ]),
    ).toHaveLength(2);
  });
});
