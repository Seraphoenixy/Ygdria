import { Capacitor } from "@capacitor/core";
import { CapacitorShareTarget } from "@capgo/capacitor-share-target";
import { Filesystem } from "@capacitor/filesystem";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "./i18n";

interface SharedImage {
  name: string;
  mimeType: string;
  uri: string;
}

let clientRef: YgdriaClient | null = null;
let localeRef: Locale = "zh-CN";
const pending: SharedImage[] = [];
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
    if (clientRef) {
      void flushPending().catch((error) => console.error("Failed to save shared images", error));
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
  if (!clientRef || pending.length === 0) return;
  const images = pending.splice(0, pending.length);
  await saveImagesAsNote(clientRef, images, localeRef);
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

/** Creates a single new note containing every shared image embedded via its
 *  uploaded attachment URL. */
async function saveImagesAsNote(client: YgdriaClient, images: SharedImage[], locale: Locale): Promise<void> {
  const firstTitle = images[0]?.name.replace(/\.[^.]+$/, "") ?? "";
  const title =
    images.length === 1
      ? firstTitle || t(locale, "sharedImageNote")
      : t(locale, "sharedImagesNote", { count: String(images.length) });
  const note = await client.createNote({ title });
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
  await client.putMarkdown(note.id, markdown.join("\n\n"), note.version, true);
}
