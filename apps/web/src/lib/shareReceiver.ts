import { Capacitor } from "@capacitor/core";
import { CapacitorShareTarget } from "@capgo/capacitor-share-target";
import { Filesystem } from "@capacitor/filesystem";
import type { YgdriaClient } from "@ygdria/api-client";
import { markdownToTiptap } from "@ygdria/editor/markdown";
import { t, type Locale } from "./i18n";

interface SharedImage {
  name: string;
  mimeType: string;
  uri: string;
}

let clientRef: YgdriaClient | null = null;
let localeRef: Locale = "zh-CN";
const pending: SharedImage[] = [];
const pendingTexts: string[] = [];
let registered = false;

/**
 * Registers the native share-target listener. Safe to call once at startup;
 * it is a no-op in the browser or any non-native platform. Images shared from
 * other apps (e.g. the photo gallery) are queued and flushed once an
 * authenticated API client is provided via {@link configureShareReceiver}.
 */
export function initShareReceiver(): void {
  if (registered || !Capacitor.isNativePlatform()) return;
  if (!Capacitor.isPluginAvailable("CapacitorShareTarget")) return;
  registered = true;
  void CapacitorShareTarget.addListener("shareReceived", (event) => {
    const images = (event.files ?? []).filter(
      (file) => typeof file.mimeType === "string" && file.mimeType.startsWith("image/"),
    );
    for (const file of images) {
      pending.push({ name: file.name, mimeType: file.mimeType, uri: file.uri });
    }
    const sharedText = extractSharedText(event);
    if (sharedText) pendingTexts.push(sharedText);
    if (clientRef && (images.length > 0 || pendingTexts.length > 0)) {
      void flushPending().catch((error) => console.error("Failed to save shared content", error));
    }
  });
}

/**
 * Supplies the authenticated API client (and current locale) so any queued
 * shares can be persisted. Call this once the app is initialized with a client
 * that can upload attachments.
 */
export function configureShareReceiver(client: YgdriaClient, locale: Locale): void {
  clientRef = client;
  localeRef = locale;
  if (pending.length) {
    void flushPending().catch((error) => console.error("Failed to save shared images", error));
  }
}

async function flushPending(): Promise<void> {
  if (!clientRef) return;
  if (pending.length > 0) {
    const images = pending.splice(0, pending.length);
    await saveImagesAsNote(clientRef, images, localeRef);
  }
  if (pendingTexts.length > 0) {
    const texts = pendingTexts.splice(0, pendingTexts.length);
    for (const text of texts) await saveTextAsNote(clientRef, text, localeRef);
  }
}

/** Reads a shared file URI into raw bytes using the most reliable method
 *  available on the current platform. */
async function readSharedFile(
  uri: string,
  fallbackMimeType = "application/octet-stream",
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    const meta = uri.slice(0, comma);
    const mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? "application/octet-stream";
    const binary = atob(uri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, mimeType };
  }
  try {
    const response = await fetch(uri);
    if (response.ok) {
      const blob = await response.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { bytes, mimeType: blob.type || fallbackMimeType };
    }
  } catch {
    // Fall through to the Filesystem read below.
  }
  const result = await Filesystem.readFile({ path: uri });
  const data = typeof result.data === "string" ? result.data : "";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, mimeType: fallbackMimeType };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  return `sha256:${Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** Normalize a share-target event into shared text, if it carries any. */
export function extractSharedText(event: unknown): string | null {
  const source = event as { text?: unknown; url?: unknown };
  for (const key of ["text", "url"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Derive a note title and Markdown body from shared text. A bare URL
 *  becomes a titled link; anything else keeps its lines with a truncated
 *  first-line title. Returns null for effectively empty input. */
export function sharedTextToNote(text: string): { title: string; markdown: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  const title = (firstLine || trimmed).slice(0, 80);
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { title: title || "link", markdown: `[${title}](${trimmed})` };
  }
  return { title, markdown: trimmed };
}

/** Persists shared text / a URL as its own note under today's calendar day. */
async function saveTextAsNote(client: YgdriaClient, text: string, locale: Locale): Promise<void> {
  const note = sharedTextToNote(text);
  if (!note) return;
  const isLink = /^https?:\/\//i.test(text.trim());
  const created = await client.createTodayNote({
    title: isLink ? t(locale, "sharedLinkNote") : t(locale, "sharedTextNote"),
  });
  // A meaningful title beats the generic label when one is derivable.
  const title = note.title || created.title;
  if (title !== created.title) {
    const renamed = await client.updateNote(created.id, { title, expectedVersion: created.version });
    await client.updateNote(created.id, {
      content: markdownToTiptap(note.markdown).document,
      expectedVersion: renamed.version,
    });
    return;
  }
  await client.updateNote(created.id, {
    content: markdownToTiptap(note.markdown).document,
    expectedVersion: created.version,
  });
}

/** Creates a single new note containing every shared image embedded via its
 *  uploaded attachment URL. */
async function saveImagesAsNote(client: YgdriaClient, images: SharedImage[], locale: Locale): Promise<void> {
  const firstTitle = images[0]?.name.replace(/\.[^.]+$/, "") ?? "";
  const title =
    images.length === 1
      ? firstTitle || t(locale, "sharedImageNote")
      : t(locale, "sharedImagesNote", { count: String(images.length) });
  // A received image belongs to today's calendar day, matching notes created
  // from the calendar shortcut. `createTodayNote` ensures that day exists and
  // uses it as the new note's parent instead of falling back to the root.
  const note = await client.createTodayNote({ title });
  const markdown: string[] = [];
  for (const image of images) {
    const { bytes, mimeType } = await readSharedFile(image.uri, image.mimeType);
    const filename = image.name || `image.${mimeType.split("/")[1] ?? "png"}`;
    const hash = await sha256Hex(bytes);
    const uploaded = await client.uploadAttachmentByHash(
      hash,
      note.id,
      filename,
      new Blob([Uint8Array.from(bytes)], { type: mimeType }),
    );
    markdown.push(`![](${uploaded.url})`);
  }
  await client.updateNote(note.id, {
    content: markdownToTiptap(markdown.join("\n\n")).document,
    expectedVersion: note.version,
  });
}
