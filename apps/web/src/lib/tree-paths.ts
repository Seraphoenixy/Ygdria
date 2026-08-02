import type { TreePlacement } from "../types/workspace";

/**
 * Computes the full ancestor chain from a placement up to the system root.
 * Returns an array of placementIds from the root down to (and including) the given placement.
 * If `placementId` is not found in the byId map, returns an empty array.
 */
export function ancestorChain(
  placementId: string,
  byId: Map<string, TreePlacement>,
): string[] {
  if (!byId.has(placementId)) return [];

  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = placementId;

  while (cur) {
    if (seen.has(cur)) break; // Cycle guard
    seen.add(cur);
    chain.unshift(cur);
    cur = byId.get(cur)?.parentPlacementId ?? null;
    if (cur === null) break; // Reached the system root (parentPlacementId === null)
  }

  return chain;
}

/**
 * Resolves the placementId for a workspace tab of kind "note".
 *
 * - If the tab has an explicit `placementId`, use it directly (supports clone: the tab
 *   remembers which specific placement was clicked).
 * - Otherwise, fall back to the first non-trashed placement with the matching noteId.
 *
 * Returns `undefined` when no placement can be resolved.
 */
export function resolvePlacementId(
  noteId: string,
  explicitPlacementId: string | undefined,
  byId: Map<string, TreePlacement>,
  byNoteId: Map<string, TreePlacement[]>,
): string | undefined {
  // Clone-aware: use the explicit placementId from the tab if available.
  if (explicitPlacementId !== undefined) {
    return byId.has(explicitPlacementId) ? explicitPlacementId : undefined;
  }
  // Fallback: find the first non-trashed placement for this noteId.
  const placements = byNoteId.get(noteId) ?? [];
  const first = placements.find((p) => !p.isTrashed && !p.isTrash);
  return first?.placementId;
}

/**
 * Computes the auto-expansion set based on a list of workspace tabs.
 *
 * The expansion set is the union of:
 * 1. System root and calendar root placements (always expanded).
 * 2. The full ancestor chain for each open note tab's resolved placementId.
 *
 * When a placement resolves to multiple chains (cloned notes), all chains are included.
 */
export function computeAutoExpansion(
  openNoteIds: Array<{ noteId: string; placementId?: string }>,
  byId: Map<string, TreePlacement>,
  byNoteId: Map<string, TreePlacement[]>,
  rootPlacements: Iterable<string>,
): Set<string> {
  const expanded = new Set(rootPlacements);

  for (const tab of openNoteIds) {
    const resolved = resolvePlacementId(tab.noteId, tab.placementId, byId, byNoteId);
    if (!resolved) continue;
    const chain = ancestorChain(resolved, byId);
    for (const id of chain) expanded.add(id);
  }

  return expanded;
}
