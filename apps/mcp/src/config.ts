import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Config {
  baseUrl: string;
}
const DEFAULT_CONFIG_FILE = fileURLToPath(
  new URL("../ygdria-mcp.ini", import.meta.url),
);

export function parseIni(text: string): { url?: string } {
  const result: { url?: string } = {};
  let section = "";
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error(`Invalid INI syntax on line ${index + 1}`);
    if (section !== "etapi") continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key === "url" || key === "baseurl")
      result.url = line.slice(separator + 1).trim();
    // Legacy token / allowWrite entries are ignored; Ygdria's switch is authoritative.
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env.YGDRIA_CONFIG_FILE?.trim() || DEFAULT_CONFIG_FILE;
  const ini = existsSync(path) ? parseIni(readFileSync(path, "utf8")) : {};
  const raw =
    env.YGDRIA_ETAPI_URL?.trim() || ini.url?.trim() || "http://127.0.0.1:4318";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ETAPI URL must be a valid absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("ETAPI URL must use HTTP(S) and a loopback host");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "ETAPI URL must be an origin only, without credentials, path, query, or fragment",
    );
  return { baseUrl: url.origin };
}
