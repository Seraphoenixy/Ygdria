export type ParsedFrontMatter = {
  title?: string;
  tags: string[];
  /** Keys present in the fence that this importer does not map anywhere. */
  unmappedKeys: string[];
};

/**
 * Extract a leading YAML-subset front-matter block and return the Markdown
 * body without it. Handles CRLF and a BOM, which the server-side converter's
 * fence regex does not, so callers should prefer this body for content upload.
 */
export function parseFrontMatter(markdown: string): { data: ParsedFrontMatter; body: string } {
  const source = markdown.replace(/^\uFEFF/, "");
  const fence = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fence) return { data: { tags: [], unmappedKeys: [] }, body: markdown };

  const data: ParsedMatter = { tags: [], unmappedKeys: [] };
  const lines = fence[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "title") {
      data.title = scalar(value);
      continue;
    }
    if (key === "tags") {
      if (!value) {
        // YAML block list: each "- item" line until the next key.
        while (index + 1 < lines.length && /^-\s/.test(lines[index + 1].trim())) {
          index += 1;
          const item = scalar(lines[index].trim().slice(1).trim());
          if (item) data.tags.push(item);
        }
      } else {
        data.tags.push(...listValues(value));
      }
      continue;
    }
    data.unmappedKeys.push(key);
  }
  return { data, body: source.slice(fence[0].length) };
}

type ParsedMatter = { title?: string; tags: string[]; unmappedKeys: string[] };

/** Strip one level of quotes; numbers and booleans stay literal strings. */
function scalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^"([\s\S]*)"$|^'([\s\S]*)'$/);
  return (quoted ? quoted[1] ?? quoted[2] : trimmed) || undefined;
}

function listValues(value: string) {
  const inner = value.match(/^\[([\s\S]*)\]$/);
  const raw = inner ? inner[1] : value;
  // Split on commas outside quotes so "x, y" stays one item.
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items
    .map((item) => scalar(item))
    .filter((item): item is string => Boolean(item));
}
