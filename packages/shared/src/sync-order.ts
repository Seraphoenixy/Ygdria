type SyncEntry = {
  entityType?: unknown;
  entityId?: unknown;
  changeKind?: unknown;
  data?: { id?: unknown; parentPlacementId?: unknown } | null;
};

/** Order one materialized batch for application, without changing cursor/change ids.
 * Run before request splitting too, so older receivers see parents before children. */
export function orderSyncChanges<T>(changes: readonly T[]): T[] {
  const entry = (change: T): SyncEntry =>
    change && typeof change === "object" ? (change as SyncEntry) : {};
  const notes: T[] = [],
    placements: T[] = [],
    orders: T[] = [],
    others: T[] = [];
  for (const change of changes) {
    const type = entry(change).entityType;
    (type === "note"
      ? notes
      : type === "placement"
        ? placements
        : type === "placement-order"
          ? orders
          : others
    ).push(change);
  }
  const pendingIds = new Map<unknown, number>();
  for (const change of placements) {
    const value = entry(change);
    if (value.changeKind !== "deleted" && value.data) {
      const id = value.data.id ?? value.entityId;
      if (typeof id === "string") pendingIds.set(id, (pendingIds.get(id) ?? 0) + 1);
    }
  }
  const sorted: T[] = [];
  let pending = placements;
  while (pending.length) {
    const deferred: T[] = [];
    for (const change of pending) {
      const value = entry(change);
      if (
        value.changeKind !== "deleted" &&
        value.data &&
        typeof value.data.parentPlacementId === "string" &&
        pendingIds.has(value.data.parentPlacementId)
      ) {
        deferred.push(change);
        continue;
      }
      sorted.push(change);
      if (value.changeKind !== "deleted" && value.data) {
        const id = value.data.id ?? value.entityId;
        const count = (pendingIds.get(id) ?? 1) - 1;
        if (count) pendingIds.set(id, count);
        else pendingIds.delete(id);
      }
    }
    if (deferred.length === pending.length)
      throw Object.assign(new Error("Sync placement dependencies contain a cycle"), {
        statusCode: 409,
        code: "SYNC_PLACEMENT_CYCLE",
      });
    pending = deferred;
  }
  return [...notes, ...sorted, ...orders, ...others];
}
