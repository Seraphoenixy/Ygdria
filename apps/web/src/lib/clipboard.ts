import { Capacitor } from "@capacitor/core";

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

async function webReadText(): Promise<string> {
  return navigator.clipboard.readText();
}

async function webWriteText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

async function webReadHtml(): Promise<string | null> {
  if (!navigator.clipboard?.read) return null;
  const [item] = await navigator.clipboard.read();
  if (item?.types.includes("text/html")) {
    return (await item.getType("text/html")).text();
  }
  return null;
}

export async function readClipboardText(): Promise<string> {
  if (isNative()) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      const result = await Clipboard.read();
      return result.value ?? "";
    } catch {
      // Native plugin unavailable; fall back to Web API
    }
  }
  return webReadText();
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isNative()) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      await Clipboard.write({ string: text });
      return;
    } catch {
      // Native plugin unavailable; fall back to Web API
    }
  }
  return webWriteText(text);
}

export async function readClipboardHtml(): Promise<string | null> {
  if (isNative()) {
    // Native clipboard plugins typically only expose plain text; skip HTML
    // read on native so the caller falls back to readText.
    return null;
  }
  return webReadHtml();
}

export type ClipboardAdapter = {
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
  readHtml: () => Promise<string | null>;
};

export const clipboardAdapter: ClipboardAdapter = {
  readText: readClipboardText,
  writeText: writeClipboardText,
  readHtml: readClipboardHtml,
};