/** Fetch and consume a remote response under one deadline. */
export async function readRemoteResponse(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const isBinary = !response.headers.get("content-type")?.includes("application/json");
    const body = isBinary ? await response.arrayBuffer() : await response.text();
    return { response, body, isBinary };
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`Remote request timed out after ${timeoutMs / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
