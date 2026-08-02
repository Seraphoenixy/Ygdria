import { useRef, useState } from "react";
import { unzipSync } from "fflate";
import type { YgdriaClient } from "@ygdria/api-client";
import { tiptapToMarkdown } from "@ygdria/editor/markdown";
import { t, type Locale } from "../lib/i18n";
import { readSettings } from "../features/settings/settingsStore";
import type { TreePlacement } from "../types/workspace";
import type { ProtectedClientSession, ProtectedPayload } from "../lib/client-crypto";

type UseNoteTransferOptions = {
  client: YgdriaClient;
  tree: TreePlacement[];
  locale: Locale;
  refreshTree: () => void;
  /** Client-side protected session; when unlocked, protected notes can be exported as plaintext. */
  session: ProtectedClientSession;
  /** Whether the protected session is currently unlocked. */
  unlocked: boolean;
  onImportComplete: (summary: { notes: number; attachments: number; estimatedBytes: number }) => void;
};

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  return `sha256:${Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function archiveAssetPath(files: Record<string, Uint8Array>, basePath: string, reference: string) {
  let decoded = reference.trim().split(/[?#]/, 1)[0];
  if (!decoded) return undefined;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep a malformed percent escape literal; it may still match an archive entry.
  }
  const normalized = decoded
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "");
  const candidates = [
    `${basePath}${normalized}`,
    `${basePath}${normalized.split("/").at(-1) ?? normalized}`,
  ];
  return candidates.find((path) => files[path]);
}

/** Matches one local attachment reference without matching filename substrings. */
function attachmentReferencePattern() {
  return /!?\[[^\]]*\]\(([^\s)]+)[^)]*\)|<img[^>]+src=["']([^"']+)["'][^>]*>|<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
}

function replaceImportedNoteLinks(
  markdown: string,
  files: Record<string, Uint8Array>,
  basePath: string,
  importedNotes: Map<string, { id: string; title: string }>,
) {
  const targetFor = (reference: string) => {
    if (/^(https?:|data:|\/)/i.test(reference)) return undefined;
    const archivePath = archiveAssetPath(files, basePath, reference);
    return archivePath ? importedNotes.get(archivePath) : undefined;
  };
  // Trilium exports note links as HTML anchors. Preserve external anchors,
  // but turn local links to another exported note into native references.
  let result = markdown.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (matched, reference, label) => {
    const target = targetFor(reference);
    if (!target) return matched;
    const title = String(label).replace(/<[^>]*>/g, "").trim() || target.title;
    return `[[note:${target.id}|${title}]]`;
  });
  result = result.replace(/(?<!!)\[([^\]]*)\]\(([^\s)]+)[^)]*\)/g, (matched, label, reference) => {
    const target = targetFor(reference);
    return target ? `[[note:${target.id}|${label || target.title}]]` : matched;
  });
  return result;
}

/** Imports and exports notes without coupling the transfer workflow to workspace UI state. */
export function useNoteTransfer({ client, tree, locale, refreshTree, session, unlocked, onImportComplete }: UseNoteTransferOptions) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importTargetPlacementId, setImportTargetPlacementId] = useState<string>();

  const openImportDialog = (targetPlacementId: string) => {
    setImportTargetPlacementId(targetPlacementId);
    importInputRef.current?.click();
  };

  const exportPlacements = async (placements: TreePlacement[]) => {
    const format = readSettings().transferFormat;
    const rootIds = new Set(placements.map((placement) => placement.placementId));
    const subtree = tree.filter((placement) => {
      let current: TreePlacement | undefined = placement;
      const seen = new Set<string>();
      while (current && !seen.has(current.placementId)) {
        if (rootIds.has(current.placementId)) return !placement.isSystem && !placement.isTrash;
        seen.add(current.placementId);
        current = tree.find((item) => item.placementId === current!.parentPlacementId);
      }
      return false;
    });
    // Protected notes are only exportable when the client session is unlocked.
    // When locked, they are skipped so their ciphertext is never written out
    // and no plaintext leaks into a user-selected export file.
    const exportable = subtree.filter((placement: any) => !placement.isProtected || unlocked);
    const notes = await Promise.all(exportable.map(async (placement: TreePlacement) => {
      if (placement.isProtected && placement.contentJson) {
        const payload = await session.decrypt<ProtectedPayload>(placement.contentJson);
        return {
          sourcePlacementId: placement.placementId,
          parentSourceId: rootIds.has(placement.placementId) ? null : placement.parentPlacementId,
          note: { id: placement.noteId, title: payload.title, content: payload.content, isProtected: true },
        };
      }
      return {
        sourcePlacementId: placement.placementId,
        parentSourceId: rootIds.has(placement.placementId) ? null : placement.parentPlacementId,
        note: await client.getNote(placement.noteId),
      };
    }));
    const contents = format === "json"
      ? JSON.stringify({ entries: notes.map(({ sourcePlacementId, parentSourceId, note }) => ({ sourcePlacementId, parentSourceId, title: note.title, content: note.content })) }, null, 2)
      : (await Promise.all(notes.map(async ({ note }) => {
          // Protected notes are decrypted locally; their content is a TipTap doc
          // that must be converted to markdown without a server round-trip.
          if ((note as any).isProtected) return tiptapToMarkdown(note.content).markdown;
          return client.content(note.id);
        }))).join("\n\n---\n\n");
    const blob = new Blob([contents], { type: format === "json" ? "application/json" : "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ygdria-notes.${format === "json" ? "json" : "md"}`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const importNotes = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const summary = { notes: 0, attachments: 0, estimatedBytes: file.size };
    const createImportedNote = async (input: Parameters<YgdriaClient["createNote"]>[0]) => {
      const note = await client.createNote(input);
      summary.notes += 1;
      return note;
    };
    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".zip")) {
      const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const decoder = new TextDecoder();
      const triliumMeta = files["!!!meta.json"];
      if (triliumMeta) {
        const meta = JSON.parse(decoder.decode(triliumMeta)) as { files?: any[] };
        const importedNotes = new Map<string, { id: string; title: string }>();
        const pendingContent: Array<{ source: any; note: any; basePath: string }> = [];
        const importNode = async (source: any, parentPlacementId: string | undefined, basePath: string) => {
          const note = await createImportedNote({ title: source.title || t(locale, "untitledNote"), parentPlacementId });
          const placement = (await client.tree()).find((item) => item.noteId === note.id);
          if (typeof source.dataFileName === "string" && files[`${basePath}${source.dataFileName}`])
            importedNotes.set(`${basePath}${source.dataFileName}`, { id: note.id, title: source.title || t(locale, "untitledNote") });
          pendingContent.push({ source, note, basePath });
          const childBase = source.dirFileName ? `${basePath}${source.dirFileName}/` : basePath;
          for (const child of source.children ?? []) await importNode(child, placement?.placementId, childBase);
        };
        const importContent = async ({ source, note, basePath }: { source: any; note: any; basePath: string }) => {
          const attachmentUrls = new Map<string, string>();
          const upload = async (archivePath: string, filename = archivePath.split("/").at(-1)!) => {
            if (attachmentUrls.has(archivePath)) return attachmentUrls.get(archivePath)!;
            const bytes = files[archivePath];
            const resolvedFilename = filename.trim() || archivePath.split("/").at(-1)?.trim();
            // Some Trilium exports contain an empty attachment metadata record.
            // It has no usable filename and must not be sent to the API.
            if (!bytes || !resolvedFilename) return "";
            const result = await client.uploadAttachmentByHash(await sha256(bytes), note.id, resolvedFilename, new Blob([bytes]));
            summary.attachments += 1;
            attachmentUrls.set(archivePath, result.url);
            return result.url;
          };
          for (const attachment of source.attachments ?? []) {
            const dataFileName = typeof attachment.dataFileName === "string" ? attachment.dataFileName : "";
            const archivePath = archiveAssetPath(files, basePath, dataFileName);
            if (archivePath) await upload(archivePath, dataFileName);
          }
          let markdown = "";
          if (source.dataFileName && files[`${basePath}${source.dataFileName}`]) {
            markdown = decoder.decode(files[`${basePath}${source.dataFileName}`]);
            markdown = markdown.replace(/^\uFEFF?\s*#\s+[^\r\n]+\r?\n+/, "");
            markdown = replaceImportedNoteLinks(markdown, files, basePath, importedNotes);
            const attachmentRefs = [...markdown.matchAll(attachmentReferencePattern())];
            const replacementUrls = new Map<string, string>();
            for (const match of attachmentRefs) {
              const reference = match[1] ?? match[2] ?? match[3];
              if (/^(https?:|data:|\/)/i.test(reference)) continue;
              const archivePath = archiveAssetPath(files, basePath, reference);
              const url = archivePath ? await upload(archivePath) : "";
              if (url) replacementUrls.set(reference, url);
            }
            // Replace only the captured value inside each complete Markdown or
            // HTML node. A global filename replacement corrupts overlapping
            // names such as `image.jpg` and `1_image.jpg`.
            markdown = markdown.replace(attachmentReferencePattern(), (matched, markdownReference, imageReference, linkReference) => {
              const reference = markdownReference ?? imageReference ?? linkReference;
              const url = replacementUrls.get(reference);
              return url ? matched.replace(reference, url) : matched;
            });
          }
          if (markdown.trim()) await client.putMarkdown(note.id, markdown, note.version, true);
        };
        for (const root of meta.files ?? []) await importNode(root, importTargetPlacementId, "");
        for (const pending of pendingContent) await importContent(pending);
        event.target.value = "";
        refreshTree();
        onImportComplete(summary);
        return;
      }
      const directories = [...new Set(Object.keys(files).flatMap((path) => path.split("/").slice(0, -1).map((_part, index, all) => all.slice(0, index + 1).join("/"))))].filter(Boolean);
      const folderParents = new Map<string, string | undefined>([["", importTargetPlacementId]]);
      for (const directory of directories) {
        const parentPath = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
        const folder = await createImportedNote({ title: directory.split("/").at(-1)!, parentPlacementId: folderParents.get(parentPath) });
        const placement = (await client.tree()).find((item) => item.noteId === folder.id);
        if (placement) folderParents.set(directory, placement.placementId);
      }
      for (const [path, data] of Object.entries(files).filter(([path]) => /\.(md|markdown)$/i.test(path))) {
        const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const note = await createImportedNote({ title: path.split("/").at(-1)!.replace(/\.(md|markdown)$/i, ""), parentPlacementId: folderParents.get(directory) });
        let markdown = decoder.decode(data);
        const imagePattern = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
        for (const match of [...markdown.matchAll(imagePattern)]) {
          const imagePath = match[2].replace(/^\.\//, "");
          const source = files[`${directory ? `${directory}/` : ""}${imagePath}`];
          if (!source) continue;
          const upload = await client.uploadAttachmentByHash(await sha256(source), note.id, imagePath.split("/").at(-1)!, new Blob([source]));
          summary.attachments += 1;
          markdown = markdown.replace(match[0], `![${match[1]}](${upload.url})`);
        }
        await client.putMarkdown(note.id, markdown, note.version, true);
      }
    } else if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text) as { notes?: Array<{ title: string; content?: any }>; entries?: Array<{ sourcePlacementId: string; parentSourceId: string | null; title: string; content?: any }> };
      const importedParents = new Map<string, string | undefined>();
      for (const item of parsed.entries ?? []) {
        const note = await createImportedNote({ title: item.title || t(locale, "untitledNote"), content: item.content, parentPlacementId: item.parentSourceId ? importedParents.get(item.parentSourceId) : importTargetPlacementId });
        const placement = (await client.tree()).find((entry) => entry.noteId === note.id);
        if (placement) importedParents.set(item.sourcePlacementId, placement.placementId);
      }
      for (const item of parsed.notes ?? []) await createImportedNote({ title: item.title || t(locale, "untitledNote"), content: item.content, parentPlacementId: importTargetPlacementId });
    } else {
      const note = await createImportedNote({ title: file.name.replace(/\.[^.]+$/, "") || t(locale, "untitledNote"), parentPlacementId: importTargetPlacementId });
      await client.putMarkdown(note.id, text, note.version, true);
    }
    event.target.value = "";
    refreshTree();
    onImportComplete(summary);
  };

  return { importInputRef, openImportDialog, exportPlacements, importNotes };
}
