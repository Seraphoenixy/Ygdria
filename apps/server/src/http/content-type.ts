import { extname } from "node:path";
import { readFile } from "node:fs/promises";

export function contentType(filename: string) {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };
  return types[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export async function mediaType(filename: string) {
  const data = await readFile(filename);
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "image/jpeg";
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  )
    return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  // SVGs imported from external note systems must be identified from their
  // contents, rather than trusting a user-controlled filename. draw.io, for
  // example, writes an XML declaration, a comment and a DOCTYPE before <svg>.
  // Strip only those standard prolog constructs, then require <svg> to be the
  // first document element.
  let svgPrefix = data.subarray(0, 64 * 1024).toString("utf8").replace(/^\uFEFF/, "");
  let removedProlog = true;
  while (removedProlog) {
    const before = svgPrefix;
    svgPrefix = svgPrefix
      .replace(/^\s*<\?[^?]*\?>\s*/i, "")
      .replace(/^\s*<!--[\s\S]*?-->\s*/i, "")
      .replace(/^\s*<!DOCTYPE\s+svg[^>]*>\s*/i, "");
    removedProlog = svgPrefix !== before;
  }
  if (/^\s*<svg(?:\s|>)/i.test(svgPrefix)) return "image/svg+xml";
  // Unknown formats are deliberately served as opaque downloads, never as a
  // MIME type inferred from a user-controlled filename.
  return "application/octet-stream";
}
