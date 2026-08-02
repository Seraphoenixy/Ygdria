import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { YgdriaClient } from "@ygdria/api-client";
import { StaticDocument } from "@ygdria/editor";
import { ChevronRight, FileText, MoreVertical } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";

export function ChildNoteList({
  children,
  childrenByParent,
  client,
  locale,
  onOpen,
  onMore,
}: {
  children: TreePlacement[];
  childrenByParent: Map<string | null, TreePlacement[]>;
  client: YgdriaClient;
  locale: Locale;
  onOpen: (placement: TreePlacement) => void;
  onMore: (placement: TreePlacement, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const allPlacements = useMemo(
    () => [...childrenByParent.values()].flat(),
    [childrenByParent],
  );
  const expandedPlacements = allPlacements.filter(
    (item) => expandedIds.has(item.placementId) && !item.isSystem && !item.isTrash && !item.isTrashed,
  );
  const previews = useQuery({
    queryKey: ["child-note-previews", expandedPlacements.map((item) => item.placementId)],
    queryFn: async () => Promise.all(
      expandedPlacements.map(async (placement) => ({
        placementId: placement.placementId,
        note: await client.getNote(placement.noteId),
      })),
    ),
    enabled: expandedPlacements.length > 0,
  });
  const previewByPlacementId = useMemo(
    () => new Map((previews.data ?? []).map((item) => [item.placementId, item.note])),
    [previews.data],
  );
  const nestedChildren = (placementId: string) => (childrenByParent.get(placementId) ?? [])
    .filter((item) => !item.isSystem && !item.isTrash && !item.isTrashed)
    .sort((a, b) => a.position - b.position);
  const toggle = (placementId: string) => setExpandedIds((current) => {
    const next = new Set(current);
    next.has(placementId) ? next.delete(placementId) : next.add(placementId);
    return next;
  });
  const renderItem = (placement: TreePlacement): ReactNode => {
    const expanded = expandedIds.has(placement.placementId);
    const nested = nestedChildren(placement.placementId);
    const preview = previewByPlacementId.get(placement.placementId);
    return (
      <li key={placement.placementId} className={expanded ? "expanded" : ""}>
        <div className="child-note-row">
          <button className="child-note-toggle" type="button" aria-label={t(locale, expanded ? "collapseNote" : "expandNote")} aria-expanded={expanded} onClick={() => toggle(placement.placementId)}>
            <ChevronRight size={20} />
          </button>
          <button className="child-note-open" type="button" onClick={() => onOpen(placement)}>
            <FileText size={20} aria-hidden="true" />
            <span>{placement.title}</span>
          </button>
          <button className="child-note-actions" type="button" aria-label={t(locale, "moreActions")} onClick={(event) => onMore(placement, event)}>
            <MoreVertical size={20} />
          </button>
        </div>
        {expanded && (
          <div className="child-note-preview">
            {previews.isLoading ? <p>{t(locale, "loading")}</p> : preview ? <StaticDocument document={preview.content} /> : null}
            {nested.length > 0 && <ul className="child-note-nested">{nested.map(renderItem)}</ul>}
          </div>
        )}
      </li>
    );
  };

  return children.length ? <section className="child-notes" aria-label={t(locale, "childNotes")}><ul>{children.map(renderItem)}</ul></section> : null;
}
