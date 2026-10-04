import { useCallback, useEffect, useRef, useState } from "react";
import type { YgdriaClient } from "@ygdria/api-client";

export type ConnectionState = "online" | "offline";

/**
 * Tracks server reachability for thin clients (mobile / browser) via the API
 * client's transport-level observer. Offline is informational — reading
 * cached content keeps working — and recovery automatically refreshes the
 * data the stale connection may have left behind.
 */
export function useConnectionState(client: YgdriaClient, queryClient: {
  invalidateQueries: (options: { queryKey: string[] }) => Promise<void>;
}): { state: ConnectionState; retry: () => Promise<boolean> } {
  const [state, setState] = useState<ConnectionState>("online");
  const stateRef = useRef<ConnectionState>("online");
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const apply = useCallback((next: ConnectionState) => {
    const changed = stateRef.current !== next;
    stateRef.current = next;
    setState(next);
    if (changed && next === "online") {
      // Data fetched while the connection was down may be stale.
      void queryClientRef.current.invalidateQueries({ queryKey: ["tree"] });
      void queryClientRef.current.invalidateQueries({ queryKey: ["note"] });
    }
  }, []);

  useEffect(() => {
    client.setRequestObserver(({ ok }) => apply(ok ? "online" : "offline"));
    return () => client.setRequestObserver(undefined);
  }, [client, apply]);

  const retry = useCallback(async () => {
    try {
      await client.health();
      apply("online");
      return true;
    } catch {
      apply("offline");
      return false;
    }
  }, [client, apply]);

  return { state, retry };
}
