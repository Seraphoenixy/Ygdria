/**
 * Resolves the placements currently selected in the tree.
 *
 * A plain click is represented by `selectedPlacementId`; once a modifier
 * selection exists, `selectedPlacementIds` contains the complete selection.
 * Keeping that distinction lets the active note remain visually active while
 * still allowing the active placement to participate in a multi-selection.
 */
export function effectiveSelectedPlacementIds(
  selectedPlacementIds: ReadonlySet<string>,
  selectedPlacementId?: string,
): Set<string> {
  if (selectedPlacementIds.size > 0) return new Set(selectedPlacementIds);
  return selectedPlacementId ? new Set([selectedPlacementId]) : new Set();
}

export function toggleSelectedPlacementId(
  selectedPlacementIds: ReadonlySet<string>,
  selectedPlacementId: string | undefined,
  placementId: string,
): Set<string> {
  const next = effectiveSelectedPlacementIds(selectedPlacementIds, selectedPlacementId);
  if (next.has(placementId)) next.delete(placementId);
  else next.add(placementId);
  return next;
}
