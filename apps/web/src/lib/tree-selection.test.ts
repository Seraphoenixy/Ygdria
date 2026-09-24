import { describe, expect, it } from "vitest";
import { effectiveSelectedPlacementIds, toggleSelectedPlacementId } from "./tree-selection";

describe("effective tree selection", () => {
  it("uses the active placement for a single selection", () => {
    expect(effectiveSelectedPlacementIds(new Set(), "placement-a")).toEqual(
      new Set(["placement-a"]),
    );
  });

  it("keeps a modifier selection authoritative", () => {
    expect(effectiveSelectedPlacementIds(new Set(["placement-b"]), "placement-a")).toEqual(
      new Set(["placement-b"]),
    );
  });

  it("includes the active placement when adding a second placement", () => {
    expect(toggleSelectedPlacementId(new Set(), "placement-a", "placement-b")).toEqual(
      new Set(["placement-a", "placement-b"]),
    );
  });

  it("can remove an item without losing the rest of the selection", () => {
    expect(
      toggleSelectedPlacementId(
        new Set(["placement-a", "placement-b"]),
        "placement-a",
        "placement-b",
      ),
    ).toEqual(new Set(["placement-a"]));
  });
});
