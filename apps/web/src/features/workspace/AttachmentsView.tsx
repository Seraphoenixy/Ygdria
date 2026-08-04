import { useMemo, useState, type ReactNode } from "react";
import { Image, FileText, File, Music, Video, Paperclip, Trash2, X } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";

export interface AttachmentItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  contentHash: string;
  referencingNotes: Array<{ id: string; title: string }>;
}

type AttachmentFilter = "all" | "referenced" | "unused";

function formatBytes(bytes: number, locale: Locale): string {
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

function fileIcon(mimeType: string): ReactNode {
  if (mimeType.startsWith("image/")) return <Image size={18} />;
  if (mimeType.startsWith("audio/")) return <Music size={18} />;
  if (mimeType.startsWith("video/")) return <Video size={18} />;
  if (mimeType === "application/pdf") return <FileText size={18} />;
  return <File size={18} />;
}

export function AttachmentsView({
  data,
  isLoading,
  locale,
  onOpenNote,
  onClearUnusedAttachments,
  clearingUnusedAttachments,
  onDownloadAttachment,
}: {
  data?: { attachments: AttachmentItem[]; unusedCount: number };
  isLoading: boolean;
  locale: Locale;
  onOpenNote: (noteId: string) => void;
  onClearUnusedAttachments: () => void;
  clearingUnusedAttachments: boolean;
  /** Downloads an attachment by its content hash. Returns a blob and its MIME type. */
  onDownloadAttachment?: (contentHash: string) => Promise<{ blob: Blob; mimeType: string }>;
}) {
  const [filter, setFilter] = useState<AttachmentFilter>("all");
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxLabel, setLightboxLabel] = useState("");
  const [lightboxLoading, setLightboxLoading] = useState(false);

  const attachments = data?.attachments ?? [];
  const unusedCount = data?.unusedCount ?? 0;

  const { totalSize, referencedCount } = useMemo(() => {
    let total = 0;
    let referenced = 0;
    for (const attachment of attachments) {
      total += attachment.size;
      if (attachment.referencingNotes.length > 0) referenced += 1;
    }
    return { totalSize: total, referencedCount: referenced };
  }, [attachments]);

  const visible = useMemo(() => {
    if (filter === "referenced") return attachments.filter((a) => a.referencingNotes.length > 0);
    if (filter === "unused") return attachments.filter((a) => a.referencingNotes.length === 0);
    return attachments;
  }, [attachments, filter]);

  const openLightbox = async (attachment: AttachmentItem) => {
    if (!onDownloadAttachment) return;
    setLightboxLabel(attachment.filename);
    setLightboxLoading(true);
    try {
      const { blob, mimeType } = await onDownloadAttachment(attachment.contentHash);
      const url = URL.createObjectURL(blob);
      setLightboxSrc(url);
    } catch {
      setLightboxSrc(null);
    } finally {
      setLightboxLoading(false);
    }
  };

  const closeLightbox = () => {
    if (lightboxSrc) URL.revokeObjectURL(lightboxSrc);
    setLightboxSrc(null);
    setLightboxLabel("");
  };

  if (isLoading) return <article className="attachments-view"><p className="attachments-empty">{t(locale, "loading")}</p></article>;

  return (
    <article className="attachments-view">
      <div className="attachments-header">
        <h1>{t(locale, "attachments")}</h1>
        <button
          className="attachments-clear"
          disabled={unusedCount === 0 || clearingUnusedAttachments}
          onClick={onClearUnusedAttachments}
        >
          <Trash2 size={15} /> {t(locale, "clearUnusedAttachments")}
          {unusedCount > 0 ? `（${unusedCount}）` : ""}
        </button>
      </div>

      <p className="attachments-hint">{t(locale, "attachmentsHint")}</p>

      {attachments.length === 0 ? (
        <p className="attachments-empty">{t(locale, "attachmentsEmpty")}</p>
      ) : (
        <>
          <div className="attachments-summary">
            <span>{t(locale, "attachmentsSummary", { count: String(attachments.length), size: formatBytes(totalSize, locale) })}</span>
            <span className={unusedCount > 0 ? "attachments-unused-flag" : ""}>
              {t(locale, "attachmentsUnused", { count: String(unusedCount) })}
            </span>
          </div>

          <div className="attachments-filters" role="tablist">
            {(["all", "referenced", "unused"] as const).map((key) => (
              <button
                key={key}
                className={`attachments-filter ${filter === key ? "active" : ""}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {t(locale, key === "all" ? "filterAll" : key === "referenced" ? "filterReferenced" : "filterUnused")}
                <span className="attachments-filter-count">
                  {key === "all" ? attachments.length : key === "referenced" ? referencedCount : unusedCount}
                </span>
              </button>
            ))}
          </div>

          <ul className="attachments-list">
            {visible.map((attachment) => {
              const isOrphan = attachment.referencingNotes.length === 0;
              const isImage = attachment.mimeType.startsWith("image/");
              return (
                <li
                  className={`attachment-item${isImage ? " attachment-item-image" : ""}`}
                  key={attachment.id}
                  {...(isImage
                    ? {
                        role: "button",
                        tabIndex: 0,
                        title: t(locale, "attachmentViewImage"),
                        onClick: () => { void openLightbox(attachment); },
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openLightbox(attachment); }
                        },
                      }
                    : {})}
                >
                  <div className="attachment-icon">{fileIcon(attachment.mimeType)}</div>
                  <div className="attachment-body">
                    <div className="attachment-main">
                      <strong className="attachment-filename" title={attachment.filename}>{attachment.filename}</strong>
                      <span className="attachment-meta">
                        {formatBytes(attachment.size, locale)} · {attachment.mimeType || "—"} ·{" "}
                        {new Date(attachment.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="attachment-owners">
                      <span className="attachment-owners-label">{t(locale, "attachmentOwnedBy")}</span>
                      {isOrphan ? (
                        <span className="attachment-orphan">{t(locale, "attachmentNoOwner")}</span>
                      ) : (
                        <span className="attachment-owner-list">
                          {attachment.referencingNotes.map((note) => (
                            <button
                              key={note.id}
                              className="attachment-owner"
                              title={note.title}
                              onClick={(e) => { e.stopPropagation(); onOpenNote(note.id); }}
                            >
                              {note.title}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {lightboxSrc && (
        <div className="attachment-lightbox" role="dialog" aria-label={lightboxLabel} onClick={closeLightbox}>
          <div className="attachment-lightbox-header">
            <span className="attachment-lightbox-title">{lightboxLabel}</span>
            <button type="button" className="attachment-lightbox-close" onClick={closeLightbox} aria-label={t(locale, "close")}>
              <X size={22} />
            </button>
          </div>
          <div className="attachment-lightbox-image-wrap" onClick={(e) => e.stopPropagation()}>
            <img
              className="attachment-lightbox-image"
              src={lightboxSrc}
              alt={lightboxLabel}
            />
          </div>
        </div>
      )}
      {lightboxLoading && (
        <div className="attachment-lightbox attachment-lightbox-loading" role="dialog" aria-label={lightboxLabel}>
          <span className="attachment-lightbox-spinner" />
          <span className="attachment-lightbox-loading-text">{t(locale, "loading")}</span>
        </div>
      )}
    </article>
  );
}
