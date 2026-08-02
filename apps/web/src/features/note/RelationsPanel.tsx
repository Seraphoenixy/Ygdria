import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2, CornerDownRight, Plus } from "lucide-react";
import type { YgdriaClient } from "@ygdria/api-client";
import { relationTypes, type RelationType } from "@ygdria/shared";
import { t, type Locale } from "../../lib/i18n";

type RelationEndpoint = {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  relationType: string;
  createdAt: number;
  peerTitle: string;
};

function relationLabel(locale: Locale, type: string): string {
  if (type === "uses") return t(locale, "relationUses");
  if (type === "prerequisite") return t(locale, "relationPrerequisite");
  return t(locale, "relationRelated");
}

type RelationsPanelProps = {
  noteId: string;
  client: YgdriaClient;
  locale: Locale;
  openNote: (noteId: string) => void;
};

export function RelationsPanel({ noteId, client, locale, openNote }: RelationsPanelProps) {
  const queryClient = useQueryClient();
  const relations = useQuery({
    queryKey: ["relations", noteId],
    queryFn: () => client.listRelations(noteId),
  });
  const [query, setQuery] = useState("");
  const [type, setType] = useState<RelationType>("related");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const search = useQuery({
    queryKey: ["relation-search", query, noteId],
    queryFn: () => client.search(query, false),
    enabled: query.trim().length > 0,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["relations", noteId] });

  const addMutation = useMutation({
    mutationFn: (targetNoteId: string) => client.createRelation(noteId, targetNoteId, type),
    onSuccess: () => {
      invalidate();
      setQuery("");
      setCreating(false);
      setError(undefined);
    },
    onError: () => setError(t(locale, "relationFailed")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.deleteRelation(id),
    onSuccess: invalidate,
  });

  const candidates = (search.data ?? []).filter((n) => n.id !== noteId && !n.isTrashed);

  return (
    <section className="inspector-section relations-panel">
      <div className="inspector-label">
        <Link2 size={14} /> {t(locale, "relations")}
      </div>

      <div className="relations-group">
        <div className="relations-group-title">{t(locale, "outgoingRelations")}</div>
        {relations.data?.outgoing.length ? (
          relations.data.outgoing.map((r: RelationEndpoint) => (
            <div key={r.id} className="relation-row">
              <span className="relation-type">{relationLabel(locale, r.relationType)}</span>
              <button
                type="button"
                className="relation-peer"
                onClick={() => openNote(r.targetNoteId)}
                title={r.peerTitle}
              >
                {r.peerTitle}
              </button>
              <button
                type="button"
                className="relation-delete"
                onClick={() => deleteMutation.mutate(r.id)}
                title={t(locale, "relationDelete")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        ) : (
          <p className="relation-empty">{t(locale, "relationNone")}</p>
        )}
      </div>

      <div className="relations-group">
        <div className="relations-group-title">{t(locale, "incomingRelations")}</div>
        {relations.data?.incoming.length ? (
          relations.data.incoming.map((r: RelationEndpoint) => (
            <div key={r.id} className="relation-row">
              <button
                type="button"
                className="relation-peer"
                onClick={() => openNote(r.sourceNoteId)}
                title={t(locale, "relationOpenSource")}
              >
                <CornerDownRight size={13} /> {r.peerTitle}
              </button>
              <span className="relation-type">{relationLabel(locale, r.relationType)}</span>
              <button
                type="button"
                className="relation-delete"
                onClick={() => deleteMutation.mutate(r.id)}
                title={t(locale, "relationDelete")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        ) : (
          <p className="relation-empty">{t(locale, "relationNone")}</p>
        )}
      </div>

      {creating ? (
        <div className="relation-add">
          <select value={type} onChange={(e) => setType(e.target.value as RelationType)}>
            {relationTypes.map((rt) => (
              <option key={rt} value={rt}>
                {relationLabel(locale, rt)}
              </option>
            ))}
          </select>
          <input
            autoFocus
            value={query}
            placeholder={t(locale, "relationTargetPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() && (
            <ul className="relation-search-results">
              {candidates.length ? (
                candidates.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => addMutation.mutate(n.id)}>
                      {n.title || n.path.join(" / ")}
                    </button>
                  </li>
                ))
              ) : (
                <li className="relation-empty">{t(locale, "relationNoResults")}</li>
              )}
            </ul>
          )}
          {error && <p className="relation-error">{error}</p>}
          <div className="confirm-dialog-actions">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setQuery("");
                setError(undefined);
              }}
            >
              {t(locale, "cancel")}
            </button>
            <button type="button" disabled={addMutation.isPending}>
              {t(locale, "addRelation")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="relation-add-trigger" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t(locale, "addRelation")}
        </button>
      )}
    </section>
  );
}
