import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { YgdriaClient } from "@ygdria/api-client";

/** Observe local adapter writes even when remote sync is unavailable. */
export function useWorkspaceChanges(client: YgdriaClient, enabled: boolean, editing: boolean) {
  const queryClient = useQueryClient();
  const observed = useRef<{ client: YgdriaClient; version: number } | undefined>(undefined);
  const pendingNoteRefresh = useRef(false);
  const version = useQuery({
    queryKey: ["workspace-version", client.getServerUrl()],
    queryFn: () => client.workspaceVersion(),
    enabled,
    retry: 1,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (!enabled) {
      observed.current = undefined;
      pendingNoteRefresh.current = false;
      return;
    }
    if (version.data?.version === undefined) return;
    if (observed.current?.client !== client || observed.current.version !== version.data.version) {
      observed.current = { client, version: version.data.version };
      pendingNoteRefresh.current = true;
      for (const key of ["tree", "archived", "history", "search", "tags", "graph"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    }
    // Keep the editor's live draft intact. The normal optimistic save path
    // handles any external body change before we refresh note queries.
    if (pendingNoteRefresh.current && !editing) {
      pendingNoteRefresh.current = false;
      void queryClient.invalidateQueries({ queryKey: ["note"] });
    }
  }, [client, enabled, editing, version.data?.version, queryClient]);
}
