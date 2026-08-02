import { describe, expect, it } from "vitest";
import { ancestorChain, computeAutoExpansion, resolvePlacementId } from "./tree-paths";
import type { TreePlacement } from "../types/workspace";

// ─── Helpers ────────────────────────────────────────────────────────────

function p(id: string, parentId: string | null, overrides: Partial<TreePlacement> = {}): TreePlacement {
  return {
    placementId: id,
    noteId: `note:${id}`,
    parentPlacementId: parentId,
    position: 0,
    title: id,
    ...overrides,
  } as TreePlacement;
}

function byId(placements: TreePlacement[]): Map<string, TreePlacement> {
  return new Map(placements.map((item) => [item.placementId, item]));
}

function byNoteId(placements: TreePlacement[]): Map<string, TreePlacement[]> {
  const map = new Map<string, TreePlacement[]>();
  for (const item of placements) {
    map.set(item.noteId, [...(map.get(item.noteId) ?? []), item]);
  }
  return map;
}

// ─── ancestorChain ──────────────────────────────────────────────────────

describe("ancestorChain", () => {
  it("returns the chain from node up to the system root", () => {
    // root (null parent) -> a -> b -> c
    const items = [
      p("root", null, { isSystem: true, title: "System Root" }),
      p("a", "root"),
      p("b", "a"),
      p("c", "b"),
    ];
    const map = byId(items);

    expect(ancestorChain("c", map)).toEqual(["root", "a", "b", "c"]);
    expect(ancestorChain("b", map)).toEqual(["root", "a", "b"]);
    expect(ancestorChain("a", map)).toEqual(["root", "a"]);
    expect(ancestorChain("root", map)).toEqual(["root"]);
  });

  it("returns empty array for unknown placementId", () => {
    const map = byId([p("root", null)]);
    expect(ancestorChain("nonexistent", map)).toEqual([]);
  });

  it("guards against cycles", () => {
    // Artificial cycle: a -> b -> a
    const items = [
      p("a", "b"),
      p("b", "a"),
    ];
    const map = byId(items);
    // Should terminate gracefully instead of looping forever.
    const chain = ancestorChain("a", map);
    expect(chain.length).toBeGreaterThan(0);
  });

  it("works with non-root top-level placements (parentPlacementId is something else)", () => {
    const items = [
      p("r1", null),
      p("r2", null),
      p("child", "r2"),
    ];
    const map = byId(items);

    expect(ancestorChain("child", map)).toEqual(["r2", "child"]);
  });
});

// ─── resolvePlacementId ─────────────────────────────────────────────────

describe("resolvePlacementId", () => {
  it("uses explicit placementId when available (clone support)", () => {
    const items = [
      p("place1", null, { noteId: "note1" }),
      p("place2", null, { noteId: "note1" }), // clone of note1
    ];
    const idMap = byId(items);
    const noteMap = byNoteId(items);

    // Tab explicitly opened placement2.
    expect(resolvePlacementId("note1", "place2", idMap, noteMap)).toBe("place2");
  });

  it("falls back to the first non-trashed placement when no explicit placementId", () => {
    const items = [
      p("place1", null, { noteId: "note1" }),
      p("place2", null, { noteId: "note1" }),
    ];
    const idMap = byId(items);
    const noteMap = byNoteId(items);

    // Tab opened from search/history (no placementId).
    expect(resolvePlacementId("note1", undefined, idMap, noteMap)).toBe("place1");
  });

  it("skips trashed placements in fallback", () => {
    const items = [
      p("place1", null, { noteId: "note1", isTrashed: true }),
      p("place2", null, { noteId: "note1" }),
    ];
    const idMap = byId(items);
    const noteMap = byNoteId(items);

    expect(resolvePlacementId("note1", undefined, idMap, noteMap)).toBe("place2");
  });

  it("returns undefined when explicit placementId does not exist in byId", () => {
    const items = [p("place1", null, { noteId: "note1" })];
    const idMap = byId(items);
    const noteMap = byNoteId(items);

    expect(resolvePlacementId("note1", "nonexistent", idMap, noteMap)).toBeUndefined();
  });
});

// ─── computeAutoExpansion ───────────────────────────────────────────────

describe("computeAutoExpansion", () => {
  const makeTree = (): TreePlacement[] => [
    p("sys-root", null, { isSystem: true, noteId: "sys-root-note", title: "System Root" }),
    p("cal-root", null, { isCalendar: true, noteId: "cal-root-note", title: "Calendar" }),
    p("folder-a", "sys-root", { noteId: "note-folder-a", title: "Folder A" }),
    p("note-a1", "folder-a", { noteId: "note-a1", title: "Note A1" }),
    p("note-a2", "folder-a", { noteId: "note-a2", title: "Note A2" }),
    p("folder-b", "sys-root", { noteId: "note-folder-b", title: "Folder B" }),
    p("note-b1", "folder-b", { noteId: "note-b1", title: "Note B1" }),
    p("note-b2", "folder-b", { noteId: "note-b2", title: "Note B2" }),
  ];

  it("always includes system root and calendar root", () => {
    const tree = makeTree();
    const result = computeAutoExpansion([], byId(tree), byNoteId(tree), ["sys-root", "cal-root"]);

    expect(result.has("sys-root")).toBe(true);
    expect(result.has("cal-root")).toBe(true);
  });

  it("expands ancestor chains for a single open tab", () => {
    const tree = makeTree();
    const tabs = [{ noteId: "note-a1", placementId: "note-a1" }];
    const result = computeAutoExpansion(tabs, byId(tree), byNoteId(tree), ["sys-root", "cal-root"]);

    // sys-root + cal-root + folder-a + note-a1
    expect(result.has("sys-root")).toBe(true);
    expect(result.has("cal-root")).toBe(true);
    expect(result.has("folder-a")).toBe(true);
    expect(result.has("note-a1")).toBe(true);
    // folder-b and its children should NOT be expanded
    expect(result.has("folder-b")).toBe(false);
    expect(result.has("note-b1")).toBe(false);
    expect(result.has("note-b2")).toBe(false);
  });

  it("expands ancestor chains for multiple open tabs (union)", () => {
    const tree = makeTree();
    const tabs = [
      { noteId: "note-a1", placementId: "note-a1" },
      { noteId: "note-b1", placementId: "note-b1" },
    ];
    const result = computeAutoExpansion(tabs, byId(tree), byNoteId(tree), ["sys-root", "cal-root"]);

    // Both paths should be expanded
    expect(result.has("folder-a")).toBe(true);
    expect(result.has("note-a1")).toBe(true);
    expect(result.has("folder-b")).toBe(true);
    expect(result.has("note-b1")).toBe(true);
    // Other siblings not in open tabs should NOT be expanded
    expect(result.has("note-a2")).toBe(false);
    expect(result.has("note-b2")).toBe(false);
  });

  it("collapses paths when a tab is closed (only keeps remaining tab paths)", () => {
    const tree = makeTree();
    const idMap = byId(tree);
    const noteMap = byNoteId(tree);

    // Initially two tabs open
    const tabsBoth = [
      { noteId: "note-a1", placementId: "note-a1" },
      { noteId: "note-b1", placementId: "note-b1" },
    ];
    const resultBoth = computeAutoExpansion(tabsBoth, idMap, noteMap, ["sys-root", "cal-root"]);
    expect(resultBoth.has("folder-a")).toBe(true);
    expect(resultBoth.has("folder-b")).toBe(true);

    // Close folder-b tab — folder-b path should collapse
    const tabsAfterClose = [
      { noteId: "note-a1", placementId: "note-a1" },
    ];
    const resultAfterClose = computeAutoExpansion(tabsAfterClose, idMap, noteMap, ["sys-root", "cal-root"]);
    expect(resultAfterClose.has("folder-a")).toBe(true);
    expect(resultAfterClose.has("note-a1")).toBe(true);
    expect(resultAfterClose.has("folder-b")).toBe(false);
    expect(resultAfterClose.has("note-b1")).toBe(false);
  });

  it("supports clone: uses the correct placement for cloned notes", () => {
    // Simulate a note cloned into two locations.
    const tree: TreePlacement[] = [
      p("sys-root", null, { isSystem: true, noteId: "sys-root-note" }),
      p("folder-a", "sys-root", { noteId: "note-folder-a" }),
      p("clone-in-a", "folder-a", { noteId: "shared-note" }), // cloned here
      p("folder-b", "sys-root", { noteId: "note-folder-b" }),
      p("clone-in-b", "folder-b", { noteId: "shared-note" }), // and here
    ];

    const idMap = byId(tree);
    const noteMap = byNoteId(tree);

    // Tab opened from clone-in-b -> should expand folder-b path, NOT folder-a
    const tabs = [
      { noteId: "shared-note", placementId: "clone-in-b" },
    ];
    const result = computeAutoExpansion(tabs, idMap, noteMap, ["sys-root"]);

    expect(result.has("folder-b")).toBe(true);
    expect(result.has("clone-in-b")).toBe(true);
    // Without clone support (just using noteId), folder-a would be incorrectly expanded.
    expect(result.has("folder-a")).toBe(false);
    expect(result.has("clone-in-a")).toBe(false);
  });

  it("falls back to first placement when tab has no placementId", () => {
    const tree: TreePlacement[] = [
      p("sys-root", null, { isSystem: true, noteId: "sys-root-note" }),
      p("folder-a", "sys-root", { noteId: "note-folder-a" }),
      p("my-note", "folder-a", { noteId: "my-note" }),
    ];

    const result = computeAutoExpansion(
      [{ noteId: "my-note" }], // no placementId (e.g., from search)
      byId(tree),
      byNoteId(tree),
      ["sys-root"],
    );

    expect(result.has("folder-a")).toBe(true);
    expect(result.has("my-note")).toBe(true);
  });

  it("works when no note tabs are open (only roots expanded)", () => {
    const tree = makeTree();
    const result = computeAutoExpansion([], byId(tree), byNoteId(tree), ["sys-root", "cal-root"]);

    expect(result.size).toBe(2);
    expect(result.has("sys-root")).toBe(true);
    expect(result.has("cal-root")).toBe(true);
    expect(result.has("folder-a")).toBe(false);
  });

  it("deduplicates ancestor chains for multiple tabs in the same folder", () => {
    const tree = makeTree();
    const tabs = [
      { noteId: "note-a1", placementId: "note-a1" },
      { noteId: "note-a2", placementId: "note-a2" },
    ];
    const result = computeAutoExpansion(tabs, byId(tree), byNoteId(tree), ["sys-root", "cal-root"]);

    // Both notes in same folder — folder-a only appears once.
    const folderACount = [...result].filter((id) => id === "folder-a").length;
    expect(folderACount).toBe(1); // Set deduplication
    expect(result.has("note-a1")).toBe(true);
    expect(result.has("note-a2")).toBe(true);
    // Other folder should not be expanded
    expect(result.has("folder-b")).toBe(false);
  });
});

// ─── Search temporary expansion (integration test) ──────────────────────
// These tests verify that when searching, matching items and their ancestors
// are included in the expanded set. While TreePanel handles the actual
// search interaction, these tests validate the building blocks.

describe("search scenario — building blocks", () => {
  it("ancestorChain can be used to expand matching paths", () => {
    const items = [
      p("sys-root", null, { isSystem: true }),
      p("folder", "sys-root", { noteId: "nf", title: "Projects" }),
      p("deep", "folder", { noteId: "nd", title: "Deep Note" }),
    ];
    const map = byId(items);

    // Simulate search: "Deep" matches the deep note
    const expanded = new Set<string>();
    expanded.add("sys-root");

    // Expand ancestors of the match
    const chain = ancestorChain("deep", map);
    for (const id of chain) expanded.add(id);

    expect(expanded.has("sys-root")).toBe(true);
    expect(expanded.has("folder")).toBe(true);
    expect(expanded.has("deep")).toBe(true);
  });

  it("computeAutoExpansion is not affected by search directly", () => {
    // Search expansion is handled separately by TreePanel.
    // computeAutoExpansion only depends on open tabs.
    const items = [
      p("sys-root", null, { isSystem: true }),
      p("a", "sys-root", { noteId: "na" }),
    ];
    const result = computeAutoExpansion(
      [{ noteId: "na" }],
      byId(items),
      byNoteId(items),
      ["sys-root"],
    );

    // The function itself doesn't know about search — it just expands tab paths.
    expect(result.has("a")).toBe(true);
    expect(result.size).toBe(2); // sys-root + a
  });
});
