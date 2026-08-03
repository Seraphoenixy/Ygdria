import type { NoteProperties } from "@ygdria/shared";
import { TAG_MAX_COUNT, TAG_MAX_LENGTH } from "@ygdria/shared";

/**
 * Parse and normalize a properties JSON string into a typed NoteProperties object.
 * Never throws — invalid JSON or unexpected shapes degrade to an empty object.
 */
export function parseProperties(propertiesJson: string): NoteProperties {
  try {
    const parsed = JSON.parse(propertiesJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return normalizeProperties(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/**
 * Normalize a raw parsed properties object: validate tags, trim, deduplicate,
 * strip empty values, enforce length/count limits. Preserves unknown keys.
 */
export function normalizeProperties(raw: Record<string, unknown>): NoteProperties {
  const result: NoteProperties = {};
  for (const key of Object.keys(raw)) {
    if (key === "tags") {
      result.tags = normalizeTags(raw.tags);
    } else if (key === "codeLanguage") {
      result.codeLanguage = typeof raw.codeLanguage === "string" && raw.codeLanguage
        ? raw.codeLanguage
        : undefined;
    } else {
      // Preserve unknown keys for forward compatibility
      result[key] = raw[key];
    }
  }
  return result;
}

/**
 * Normalize a tags array: trim each item, remove empty/blank, deduplicate,
 * enforce per-item length and total count limits.
 */
export function normalizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const trimmed = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= TAG_MAX_LENGTH);
  const deduped = [...new Set(trimmed)];
  const limited = deduped.slice(0, TAG_MAX_COUNT);
  return limited.length > 0 ? limited : undefined;
}

/**
 * Serialize a NoteProperties object to a JSON string for storage.
 * Strips undefined values; omits empty tags array.
 */
export function serializeProperties(properties: NoteProperties): string {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (value === undefined) continue;
    if (key === "tags" && Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return JSON.stringify(result);
}

/**
 * Read codeLanguage from a properties JSON string, with a safe default.
 */
export function readCodeLanguage(propertiesJson: string): string {
  const props = parseProperties(propertiesJson);
  return typeof props.codeLanguage === "string" && props.codeLanguage
    ? props.codeLanguage
    : "plaintext";
}

/**
 * Build a properties JSON string for a code note with the given language,
 * preserving any existing tags from the current properties.
 */
export function codeProperties(
  codeLanguage: string,
  existingPropertiesJson?: string,
): string {
  const existing = existingPropertiesJson ? parseProperties(existingPropertiesJson) : {};
  return serializeProperties({ ...existing, codeLanguage });
}

/**
 * Build a properties JSON string with the given tags,
 * preserving any existing codeLanguage from the current properties.
 */
export function tagsProperties(
  tags: string[] | undefined,
  existingPropertiesJson?: string,
): string {
  const existing = existingPropertiesJson ? parseProperties(existingPropertiesJson) : {};
  // When tags is undefined, preserve existing tags (don't overwrite)
  if (tags === undefined) {
    return serializeProperties(existing);
  }
  return serializeProperties({ ...existing, tags: tags.length > 0 ? tags : undefined });
}

/**
 * Read tags from a properties JSON string.
 */
export function readTags(propertiesJson: string): string[] {
  const props = parseProperties(propertiesJson);
  return Array.isArray(props.tags) ? props.tags : [];
}