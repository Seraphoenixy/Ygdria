/** Split hydrated requests, including the JSON envelope, before compression.
 * Keep order and only return success after every sub-batch has been accepted. */
export async function pushSyncBatches<T, R>(
  changes: readonly T[],
  send: (batch: T[]) => Promise<{ applied: number; rejected: R[] }>,
  peerId?: string,
  onResult?: (result: { applied: number; rejected: R[] }) => Promise<void>,
): Promise<{ applied: number; rejected: R[] }> {
  const encoder = new TextEncoder();
  // An undefined peerId is dropped by JSON.stringify, matching the real envelope.
  const envelopeBytes = encoder.encode(JSON.stringify({ changes: [], peerId })).length;
  const targetBytes = 4 * 1024 * 1024;
  const maxBytes = 16 * 1024 * 1024;
  const result = { applied: 0, rejected: [] as R[] };
  const deliver = async (batch: T[]): Promise<void> => {
    let response: { applied: number; rejected: R[] };
    try {
      response = await send(batch);
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode !== 413 || batch.length <= 1)
        throw error;
      const middle = Math.floor(batch.length / 2);
      await deliver(batch.slice(0, middle));
      await deliver(batch.slice(middle));
      return;
    }
    // Persistence failures must not be treated as transport rejections.
    await onResult?.(response);
    result.applied += response.applied;
    result.rejected.push(...response.rejected);
  };
  let batch: T[] = [];
  let bytes = envelopeBytes;
  for (const change of changes) {
    const size = encoder.encode(JSON.stringify(change)).length;
    if (size + envelopeBytes > maxBytes) {
      throw Object.assign(new Error("Single sync entity exceeds 16 MiB"), { statusCode: 413 });
    }
    if (batch.length && (bytes + 1 + size > targetBytes || batch.length >= 500)) {
      await deliver(batch);
      batch = [];
      bytes = envelopeBytes;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(change);
  }
  if (batch.length) await deliver(batch);
  return result;
}
