import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export type ContentCodec = "identity" | "zstd-v1" | "ciphertext-v1";

export type StoredContent = {
  data: Buffer;
  codec: ContentCodec;
  size: number;
};

const ZSTD_THRESHOLD_BYTES = 2 * 1024;

/** Encodes normal TipTap JSON for storage without changing its logical hash. */
export function encodeDocumentContent(contentJson: string): StoredContent {
  const raw = Buffer.from(contentJson, "utf8");
  if (raw.byteLength < ZSTD_THRESHOLD_BYTES) return { data: raw, codec: "identity", size: raw.byteLength };
  const compressed = zstdCompressSync(raw);
  return compressed.byteLength < raw.byteLength
    ? { data: compressed, codec: "zstd-v1", size: raw.byteLength }
    : { data: raw, codec: "identity", size: raw.byteLength };
}

/** Ciphertext is intentionally never compressed. */
export function encodeCiphertextContent(ciphertext: string): StoredContent {
  const data = Buffer.from(ciphertext, "utf8");
  return { data, codec: "ciphertext-v1", size: data.byteLength };
}

export function decodeStoredContent(data: Buffer | Uint8Array, codec: ContentCodec): string {
  const bytes = Buffer.from(data);
  switch (codec) {
    case "identity":
    case "ciphertext-v1":
      return bytes.toString("utf8");
    case "zstd-v1":
      return zstdDecompressSync(bytes).toString("utf8");
  }
}
