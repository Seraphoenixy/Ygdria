import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Archive, ArchiveRestore, Lock } from "lucide-react";
import { YgdriaClient } from "@ygdria/api-client";
import { YgdriaEditor } from "@ygdria/editor";
import { t, type Locale } from "../../lib/i18n";
import type { TreePlacement } from "../../types/workspace";
import { ProtectedClientSession, type ProtectedPayload } from "../../lib/client-crypto";
import { ChildNoteList } from "./ChildNoteList";

export type NoteContentData = {
  id: string;
  title: string;
  type?: "text" | "code" | "file";
  codeLanguage?: string;
  content: any;
  contentCiphertext?: string;
  archivedAt?: string | null;
  isProtected?: boolean;
};

export function NoteContent({ note, editing, isTrashed, locale, childNotes, childrenByParent, client, onSaveContent, onSaveTitle, onOpenChild, onChildMore, onUnarchive, onEditorReady, session, markdownView }: {
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
}) {
  const [decryptedPayload, setDecryptedPayload] = useState<ProtectedPayload | null>(null);
  const [title, setTitle] = useState(note.title);
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

  const handleSaveTitle = (nextTitle: string) => {
    if (note.isProtected && session?.isUnlocked) {
      // For protected notes, re-encrypt with updated title
      const payload = { title: nextTitle, content: decryptedPayload?.content, propertiesJson: decryptedPayload?.propertiesJson ?? "{}" };
      session.encrypt(payload).then((ciphertext) => onSaveContent(ciphertext)).catch(console.error);
    } else {
      onSaveTitle(nextTitle);
    }
  };

  const handleSaveContent = (content: any, codeLanguage?: string) => {
    if (note.isProtected && session?.isUnlocked) {
      const payload = { title: decryptedPayload?.title ?? "", content, propertiesJson: codeLanguage ? JSON.stringify({ codeLanguage }) : decryptedPayload?.propertiesJson ?? "{}" };
      session.encrypt(payload).then((ciphertext) => onSaveContent(ciphertext)).catch(console.error);
    } else {
      onSaveContent(codeLanguage ? { code: content, codeLanguage } : content);
    }
  };

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
            />}
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

function readCodeLanguage(propertiesJson?: string) {
  try {
    const value = JSON.parse(propertiesJson ?? "{}") as { codeLanguage?: unknown };
    return typeof value.codeLanguage === "string" && value.codeLanguage ? value.codeLanguage : "plaintext";
  } catch { return "plaintext"; }
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
