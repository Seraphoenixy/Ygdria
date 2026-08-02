import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type StandaloneConfig = {
  port: number;
  host: string;
  databaseUrl: string;
  origin: string;
  trustedProxy?: string | string[];
  webDist?: string;
  path: string;
};

const template = `; Ygdria standalone server configuration\n; This file is the only runtime configuration source.\n\n[server]\nport = 4318\nhost = 127.0.0.1\norigin = http://localhost:5173\n; Comma-separated IPs/CIDRs of trusted reverse proxies. Leave empty without one.\ntrusted_proxy =\n\n[storage]\n; Use an absolute path if the server is started by a service manager.\ndatabase_url = ${resolve(homedir(), ".local", "share", "ygdria", "ygdria.db")}\n\n[web]\n; Leave empty to use the bundled Web interface.\nweb_dist =\n`;

function configPath() {
  return resolve(homedir(), ".config", "ygdria", "ygdria.ini");
}

function parseIni(raw: string) {
  const result = new Map<string, string>();
  let section = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const heading = /^\[([^\]]+)]$/.exec(line);
    if (heading) { section = heading[1]!.trim().toLowerCase(); continue; }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result.set(`${section}.${line.slice(0, separator).trim().toLowerCase()}`, line.slice(separator + 1).trim());
  }
  return result;
}

export function loadStandaloneConfig(): StandaloneConfig {
  const path = configPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template, { encoding: "utf8", flag: "wx" });
  }
  const ini = parseIni(readFileSync(path, "utf8"));
  const port = Number(ini.get("server.port") ?? 4318);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid server.port in ${path}`);
  const host = ini.get("server.host") || "127.0.0.1";
  const databaseUrl = ini.get("storage.database_url") || resolve(homedir(), ".local", "share", "ygdria", "ygdria.db");
  const trustedProxies = (ini.get("server.trusted_proxy") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (databaseUrl !== ":memory:") mkdirSync(dirname(databaseUrl), { recursive: true });
  return { port, host, databaseUrl, origin: ini.get("server.origin") || "http://localhost:5173", trustedProxy: trustedProxies.length ? trustedProxies : undefined, webDist: ini.get("web.web_dist") || undefined, path };
}
