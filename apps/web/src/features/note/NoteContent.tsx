import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Archive, ArchiveRestore, Lock } from "lucide-react";
import { YgdriaClient } from "@ygdria/api-client";
import { YgdriaEditor } from "@ygdria/editor";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";
import { ProtectedClientSession, type ProtectedPayload } from "../../lib/client-crypto";
import { ChildNoteList } from "./ChildNoteList";
import { TagEditor } from "./TagEditor";

export type NoteContentData = {
  id: string;
  title: string;
  type?: "text" | "code";
  codeLanguage?: string;
  content: any;
  contentCiphertext?: string;
  archivedAt?: string | null;
  isProtected?: boolean;
  tags?: string[];
};

export function NoteContent({ note, editing, isTrashed, locale, childNotes, childrenByParent, client, onSaveContent, onSaveTitle, onOpenChild, onChildMore, onUnarchive, onEditorReady, session, markdownView, onUnlock, onUploadError }: {
  note: NoteContentData;
  editing: boolean;
  isTrashed: boolean;
  locale: Locale;
  childNotes: TreePlacement[];
  childrenByParent: Map<string | null, TreePlacement[]>;
  client: YgdriaClient;
  onSaveContent: (content: any) => void;
  onSaveTitle: (title: string) => void;
  onOpenChild: (placement: TreePlacement) => void;
  onChildMore: (placement: TreePlacement, event: MouseEvent<HTMLButtonElement>) => void;
  onUnarchive: () => void;
  onEditorReady?: (editor: any) => void;
  session?: ProtectedClientSession;
  markdownView?: boolean;
  onUnlock?: () => void;
  onUploadError?: (message: string) => void;
}) {
  const [decryptedPayload, setDecryptedPayload] = useState<ProtectedPayload | null>(null);
  const [title, setTitle] = useState(note.title);
  const [tagDraft, setTagDraft] = useState<string[] | null>(null);
  const decryptingRef = useRef(false);

  // Decrypt protected note content when note or session state changes
  useEffect(() => {
    if (note.isProtected && note.contentCiphertext && session?.isUnlocked) {
      decryptingRef.current = true;
      session.decrypt<ProtectedPayload>(note.contentCiphertext)
        .then((payload) => {
          setDecryptedPayload(payload);
          setTitle(payload.title);
        })
        .catch(() => { setDecryptedPayload(null); })
        .finally(() => { decryptingRef.current = false; });
    } else {
      setDecryptedPayload(null);
      setTitle(note.title);
    }
  }, [note.id, note.isProtected, note.contentCiphertext, session?.isUnlocked]);

  useEffect(() => {
    if (!note.isProtected) setTitle(note.title);
  }, [note.id, note.title, note.isProtected]);

  const displayTitle = note.isProtected ? (decryptedPayload?.title ?? "") : note.title;
  const displayContent = note.isProtected ? (decryptedPayload?.content ?? null) : note.content;
  const displayCodeLanguage = note.isProtected
    ? readCodeLanguage(decryptedPayload?.propertiesJson)
    : note.codeLanguage ?? "plaintext";
  const isLockedProtected = note.isProtected && !session?.isUnlocked;
  const persistedTags = note.isProtected
    ? readTagsFromProperties(decryptedPayload?.propertiesJson)
    : (note.tags ?? []);

  // Tag writes are asynchronous. Keep an optimistic footer value so adding or
  // removing a tag redraws immediately instead of waiting for the note query.
  useEffect(() => {
    setTagDraft(null);
  }, [note.id, note.tags, decryptedPayload?.propertiesJson]);

  const handleSaveTitle = (nextTitle: string) => {
    if (note.isProtected && session?.isUnlocked) {
      // For protected notes, re-encrypt with updated title
      const payload = { title: nextTitle, content: decryptedPayload?.content, propertiesJson: decryptedPayload?.propertiesJson ?? "{}" };
      session.encrypt(payload).then((ciphertext) => onSaveContent(ciphertext)).catch(console.error);
    } else {
      onSaveTitle(nextTitle);
    }
  };

  const handleSaveContent = (content: any, codeLanguage?: string, tags?: string[]) => {
    if (note.isProtected && session?.isUnlocked) {
      const currentProperties = safeParseProperties(decryptedPayload?.propertiesJson);
      const nextProperties = { ...currentProperties };
      if (codeLanguage !== undefined) nextProperties.codeLanguage = codeLanguage;
      if (tags !== undefined) nextProperties.tags = tags;
      const payload = { title: decryptedPayload?.title ?? "", content, propertiesJson: JSON.stringify(nextProperties) };
      session.encrypt(payload).then((ciphertext) => onSaveContent(ciphertext)).catch(console.error);
    } else {
      onSaveContent(codeLanguage ? { code: content, codeLanguage, tags } : { content, tags });
    }
  };

  const handleSaveTags = (tags: string[]) => {
    setTagDraft(tags);
    if (note.isProtected && session?.isUnlocked) {
      const currentProperties = safeParseProperties(decryptedPayload?.propertiesJson);
      const nextProperties = { ...currentProperties, tags };
      const payload = { title: decryptedPayload?.title ?? "", content: decryptedPayload?.content, propertiesJson: JSON.stringify(nextProperties) };
      session.encrypt(payload).then((ciphertext) => onSaveContent(ciphertext)).catch(console.error);
    } else {
      onSaveContent({ tags });
    }
  };

  const displayTags = tagDraft ?? persistedTags;

  const uploadImage = async (file: File) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
    const hash = `sha256:${Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("")}`;
    const result = await client.uploadAttachmentByHash(hash, note.id, file.name, file);
    return result.url;
  };
  const resolveImageSrc = useCallback(async (src: string) => {
    const attachmentId = attachmentIdFromSource(src);
    if (!attachmentId) return src;
    // Attachment endpoints require the device credential, which an <img>
    // element cannot send. Fetch through the API client and display the
    // authenticated response as an object URL instead.
    return URL.createObjectURL(await client.downloadAttachment(attachmentId));
  }, [client]);

  return <article className={`note-content${note.type === "code" ? " note-content-code" : ""}`}>
    {note.archivedAt && !isTrashed && <div className="archived-notice"><Archive size={16} /><span><strong>{t(locale, "archived")}</strong> {t(locale, "archivedHint")}</span><button onClick={onUnarchive}><ArchiveRestore size={16} /> {t(locale, "unarchive")}</button></div>}
    {isLockedProtected ? (
      <div className="protected-note-locked">
        <Lock size={24} />
        <p>{t(locale, "protectedNoteLocked")}</p>
        {onUnlock && <button type="button" className="protected-note-unlock" onClick={onUnlock}>{t(locale, "unlockProtectedSession")}</button>}
      </div>
    ) : (
      <>
        {editing && !isTrashed ? <input className="note-title-input" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => title !== displayTitle && handleSaveTitle(title)} onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setTitle(displayTitle);
            event.currentTarget.blur();
          }
        }} aria-label={t(locale, "noteTitle")} spellCheck={false} /> : <h1>{displayTitle}</h1>}
        {note.type === "code"
          ? <YgdriaEditor
                key={`${note.id}:${displayCodeLanguage}`}
                content={codeNoteDocument(typeof displayContent === "string" ? displayContent : "", displayCodeLanguage)}
                documentId={note.id}
                locale={locale}
                readOnly={!editing || isTrashed}
                onSave={editing && !isTrashed ? (document) => {
                  const block = findCodeBlock(document);
                  handleSaveContent(block.code, block.language);
                } : undefined}
                onUploadError={onUploadError}
              />
          : <YgdriaEditor
              key={note.id}
              content={displayContent}
              documentId={note.id}
              onSave={editing && !isTrashed ? handleSaveContent : undefined}
              locale={locale}
              onUploadImage={note.isProtected ? undefined : uploadImage}
              resolveImageSrc={resolveImageSrc}
              onEditorReady={onEditorReady}
              readOnly={!editing || isTrashed}
              markdownView={markdownView}
              onUploadError={onUploadError}
            />}
        {(editing && !isTrashed) || (!editing && displayTags.length > 0) ? (
          <footer className="note-content-footer">
            {editing && !isTrashed ? (
              <TagEditor tags={displayTags} locale={locale} onChange={handleSaveTags} />
            ) : (
              <div className="tag-editor tag-editor-readonly">
                <div className="tag-editor-tags">
                  {displayTags.slice(0, 2).map((tag) => (
                    <span key={tag} className="tag-badge">{tag}</span>
                  ))}
                  {displayTags.length > 2 && (
                    <span className="tag-badge tag-more">+{displayTags.length - 2}</span>
                  )}
                </div>
              </div>
            )}
          </footer>
        ) : null}
      </>
    )}
    <ChildNoteList children={childNotes} childrenByParent={childrenByParent} client={client} locale={locale} onOpen={onOpenChild} onMore={onChildMore} />
  </article>;
}

/**
 * Imported Markdown/HTML and older clients can store either a relative API
 * path or an absolute URL (occasionally with a cache-busting query). Match
 * the path instead of the complete source string so all of those forms use
 * the authenticated attachment fetch above.
 */
function attachmentIdFromSource(source: string) {
  try {
    const path = new URL(source, window.location.origin).pathname;
    const match = path.match(/^\/api\/v1\/attachments\/([^/]+)$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Safely parse a properties JSON string into a typed record.
 * Never throws — invalid JSON degrades to an empty object.
 * Only returns known keys to avoid unintentional prototype pollution.
 */
function safeParseProperties(propertiesJson: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(propertiesJson ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch { return {}; }
}

function readCodeLanguage(propertiesJson?: string): string {
  const props = safeParseProperties(propertiesJson);
  return typeof props.codeLanguage === "string" && props.codeLanguage
    ? props.codeLanguage
    : "plaintext";
}

function readTagsFromProperties(propertiesJson?: string): string[] {
  const props = safeParseProperties(propertiesJson);
  return Array.isArray(props.tags) ? props.tags as string[] : [];
}

/** Render a code note through the same read-only document pipeline as text notes. */
function codeNoteDocument(code: string, language: string) {
  return {
    type: "doc",
    content: [{
      type: "codeBlock",
      attrs: { language },
      content: code ? [{ type: "text", text: code }] : [],
    }],
  };
}

function findCodeBlock(document: any): { code: string; language: string } {
  const block = (document?.content ?? []).find((node: any) => node?.type === "codeBlock");
  return {
    code: (block?.content ?? []).map((node: any) => node?.text ?? "").join(""),
    language: typeof block?.attrs?.language === "string" && block.attrs.language ? block.attrs.language : "plaintext",
  };
}
