import { ArchiveRestore } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";
import type { RecentHistoryItem, TreePlacement } from "../../types/workspace";

export function RecentHistory({
  items, loading, locale, restoringNoteId, purgingTrash, onOpen, onRestore, onPurgeTrash,
}: {
  items: RecentHistoryItem[];
  loading: boolean;
  locale: Locale;
  restoringNoteId?: string;
  purgingTrash?: boolean;
  onOpen: (noteId: string, isTrashed: boolean) => void;
  onRestore: (noteId: string) => void;
  onPurgeTrash: () => void;
}) {
  const dayFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const groups = new Map<string, { label: string; entries: RecentHistoryItem[] }>();
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const group = groups.get(key) ?? { label: dayFormat.format(date), entries: [] };
    group.entries.push(item);
    groups.set(key, group);
  }
  const trashedCount = items.filter((item) => Boolean(item.isTrashed)).length;
  return <article className="recent-history">
    <div className="recent-history-header"><h1>{t(locale, "recentChanges")}</h1>{trashedCount > 0 && <button className="recent-history-purge" disabled={purgingTrash} onClick={onPurgeTrash}>{t(locale, "purgeTrash")}</button>}</div>
    <p className="recent-history-hint">{t(locale, "recentChangesHint")}</p>
    {loading ? <p className="recent-history-empty">{t(locale, "loading")}</p> : groups.size ? [...groups.values()].map((group) => <section className="history-day" key={group.label}><h2>{group.label}</h2><ol>{group.entries.map((item) => {
      const isTrashed = Boolean(item.isTrashed);
      return <li className={isTrashed ? "trashed" : ""} key={`${item.id}-${item.updatedAt}`}><time>{timeFormat.format(new Date(item.updatedAt))}</time><div className="history-entry"><button className="history-entry-open" onClick={() => onOpen(item.id, isTrashed)}><strong>{item.title}</strong>{!isTrashed && <span>{item.path.join(" › ") || t(locale, "notes")}</span>}</button>{isTrashed && <button className="history-entry-restore" disabled={restoringNoteId === item.id} onClick={() => onRestore(item.id)}>（{t(locale, "restoreDeleted")}）</button>}</div></li>;
    })}</ol></section>) : <p className="recent-history-empty">{t(locale, "recentChangesEmpty")}</p>}
  </article>;
}

export function ArchivedNotesPage({ items, placements, loading, locale, onOpen, onUnarchive }: {
  items: Array<{ id: string; title: string; archivedAt: number; updatedAt: string }>;
  placements: TreePlacement[];
  loading: boolean;
  locale: Locale;
  onOpen: (id: string) => void;
  onUnarchive: (id: string) => void;
}) {
  const placementById = new Map(placements.map((placement) => [placement.placementId, placement]));
  const pathFor = (noteId: string) => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = placements.find((placement) => placement.noteId === noteId);
    while (current?.parentPlacementId && !seen.has(current.placementId)) {
      seen.add(current.placementId);
      current = placementById.get(current.parentPlacementId);
      if (current && !current.isSystem) path.unshift(current.title);
    }
    return path.join(" › ");
  };
  return <article className="archived-notes-page"><h1>{t(locale, "archivedNotes")}</h1>{loading ? <p>{t(locale, "loading")}</p> : items.length ? <ul>{items.map((item) => <li key={item.id}><button className="archived-note-open" onClick={() => onOpen(item.id)}><strong>{item.title}</strong><span>{pathFor(item.id) || t(locale, "notes")} · {new Date(item.archivedAt).toLocaleString()} · {t(locale, "updated")} {new Date(item.updatedAt).toLocaleString()}</span></button><button className="archived-note-restore" onClick={() => onUnarchive(item.id)}><ArchiveRestore size={16} /> {t(locale, "unarchive")}</button></li>)}</ul> : <p>{t(locale, "recentChangesEmpty")}</p>}</article>;
}
