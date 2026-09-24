import { describe, expect, it } from "vitest";
import { updateNoteTabPlacement } from "./useWorkspaceTabs";
import type { WorkspaceTab } from "../types/workspace";

describe("updateNoteTabPlacement", () => {
  const tab: WorkspaceTab = {
    id: "note:shared:active",
    kind: "note",
    noteId: "shared",
    isTrashed: false,
    placementId: "clone-a",
  };

  it("updates an existing note tab when another clone is opened", () => {
    expect(updateNoteTabPlacement(tab, "clone-b")).toEqual({ ...tab, placementId: "clone-b" });
  });

  it("preserves the known placement when the caller has no placement context", () => {
    expect(updateNoteTabPlacement(tab)).toBe(tab);
  });

  it("does not change non-note tabs", () => {
    const settings: WorkspaceTab = { id: "settings", kind: "settings" };
    expect(updateNoteTabPlacement(settings, "ignored")).toBe(settings);
  });
});
