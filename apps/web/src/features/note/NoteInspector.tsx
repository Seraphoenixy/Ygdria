import { Info, Clock3, Link2, ListTree } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import { RelationsPanel } from "./RelationsPanel";

function formatBytes(bytes: number, locale: Locale) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

function collectHeadings(nodes: any[] | undefined): { level: number; text: string }[] {
  const result: { level: number; text: string }[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "heading") {
      result.push({
        level: node.attrs?.level ?? 1,
        text: (node.content ?? []).map((item: any) => item.text ?? "").join(""),
      });
    }
    if (node.content) result.push(...collectHeadings(node.content));
  }
  return result;
}

function Outline({ content, emptyLabel }: { content: any; emptyLabel: string }) {
  const headings = collectHeadings(content?.content);
  const scrollToHeading = (index: number) => {
    const article = document.querySelector(".document-scroll > article");
    // `.ygdria-document` is the ProseMirror root, nested inside the editor's
    // wrapper rather than a direct child of `article`, so use a descendant
    // selector. Headings are collected from the whole node tree (including
    // nested ones) so the index matches the live DOM exactly.
    const documentHeadings = article?.querySelectorAll<HTMLHeadingElement>(
      ":scope .ygdria-document h1, :scope .ygdria-document h2, :scope .ygdria-document h3, :scope .ygdria-document h4, :scope .ygdria-document h5, :scope .ygdria-document h6",
    );
    documentHeadings?.[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return headings.length ? (
    <ul className="outline-list">
      {headings.map((heading: { text: string; level: number }, index: number) => (
        <li key={`${heading.text}-${index}`} style={{ paddingLeft: (heading.level - 1) * 12 }}>
          <button type="button" onClick={() => scrollToHeading(index)}>
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  ) : (
    <p>{emptyLabel}</p>
  );
}

type NoteInspectorProps = {
  note: {
    id: string;
    createdAt: string;
    updatedAt: string;
    content: any;
    version: number;
    isProtected?: boolean;
  };
  placementId?: string;
  client: YgdriaClient;
  locale: Locale;
  editing?: boolean;
  openNote: (noteId: string) => void;
};

export function NoteInspector({
  note,
  placementId,
  client,
  locale,
  editing = false,
  openNote,
}: NoteInspectorProps) {
  const size = useQuery({
    // A placement can be selected before the corresponding note query has
    // completed. Keep the note identity in the key as well, so a response
    // started for the previous note can never be rendered for the new one.
    queryKey: ["placement-size", placementId, note.id, note.version],
    queryFn: () => client.placementSize(placementId!),
    enabled: Boolean(placementId) && !editing,
  });
  return (
    <aside className="note-inspector">
      <div className="inspector-heading">
        <Info size={16} /> {t(locale, "noteInfo")}
      </div>
      <section className="inspector-section">
        <div className="inspector-label">
          <Clock3 size={14} /> {t(locale, "created")}
        </div>
        <time>{new Date(note.createdAt).toLocaleString()}</time>
      </section>
      <section className="inspector-section">
        <div className="inspector-label">
          <Clock3 size={14} /> {t(locale, "updated")}
        </div>
        <time>{new Date(note.updatedAt).toLocaleString()}</time>
      </section>
      {!editing && size.data && (
        <section className="inspector-section">
          <div className="inspector-label">
            <Info size={14} /> {t(locale, "noteSize")}
          </div>
          <p>
            {t(locale, "logicalSize")}: {formatBytes(size.data.note.totalBytes, locale)}
          </p>
          <p>
            {t(locale, "storedSize")}: {formatBytes(size.data.note.storedTotalBytes, locale)}
          </p>
          <div className="inspector-label">
            <ListTree size={14} /> {t(locale, "subtreeSize")}
          </div>
          <p>
            {t(locale, "logicalSize")}: {formatBytes(size.data.subtree.totalBytes, locale)}
          </p>
          <p>
            {t(locale, "storedSize")}: {formatBytes(size.data.subtree.storedTotalBytes, locale)}
          </p>
          <p>{t(locale, "subtreeNotes", { count: String(size.data.subtree.noteCount) })}</p>
        </section>
      )}
      <section className="inspector-section">
        <div className="inspector-label">
          <Link2 size={14} /> {t(locale, "references")}
        </div>
        <p>{t(locale, "referencesPlaceholder")}</p>
      </section>
      <RelationsPanel noteId={note.id} client={client} locale={locale} openNote={openNote} />
      <section className="inspector-section">
        <div className="inspector-label">
          <ListTree size={14} /> {t(locale, "onThisPage")}
        </div>
        {note.isProtected ? (
          <p>{t(locale, "protectedNoteLocked")}</p>
        ) : (
          <Outline content={note.content} emptyLabel={t(locale, "noHeadings")} />
        )}
      </section>
    </aside>
  );
}
