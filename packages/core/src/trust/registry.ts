import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CACHE_DIR } from "../config.ts";
import { readJsonSync, writeFileAtomic } from "../util.ts";

interface NpmrcSettings {
  registry: string;
  scopes: Record<string, string>;
  tokens: Record<string, string>;
}

/** Reads registry settings from the project's and the user's `.npmrc`, without running npm. */
export function readNpmrc(root: string, env: NodeJS.ProcessEnv = process.env): NpmrcSettings {
  const settings: NpmrcSettings = { registry: "https://registry.npmjs.org/", scopes: {}, tokens: {} };
  const files = [path.join(os.homedir(), ".npmrc"), path.join(root, ".npmrc")];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? "");
      if (key === "registry") settings.registry = value;
      else if (/^@[^:]+:registry$/.test(key)) settings.scopes[key.split(":")[0]!] = value;
      else if (key.startsWith("//") && key.endsWith(":_authToken")) settings.tokens[key.slice(0, -":_authToken".length)] = value;
    }
  }
  if (env.npm_config_registry) settings.registry = env.npm_config_registry;
  return settings;
}

function registryFor(settings: NpmrcSettings, name: string): string {
  const scope = name.startsWith("@") ? name.split("/")[0]! : "";
  const url = settings.scopes[scope] ?? settings.registry;
  return url.endsWith("/") ? url : `${url}/`;
}

function tokenFor(settings: NpmrcSettings, url: string): string | undefined {
  const bare = url.replace(/^https?:/, "");
  let best: string | undefined;
  let bestLength = -1;
  for (const [prefix, token] of Object.entries(settings.tokens)) {
    if (bare.startsWith(prefix) && prefix.length > bestLength) {
      best = token;
      bestLength = prefix.length;
    }
  }
  return best;
}

export function attestationCachePath(root: string, name: string, version: string): string {
  return path.join(root, CACHE_DIR, "provenance", `${name.replace("/", "__")}@${version}.json`);
}

export type AttestationLookup =
  | { status: "found"; attestations: unknown; source: "cache" | "registry" }
  | { status: "missing"; reason: string };

export interface AttestationOptions {
  /** Fetch from the registry when the cache has no copy. */
  network: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns a package version's npm attestations from the repo's cache, fetching
 * and caching them when the network is allowed. The cache lets `sync`,
 * `resolve`, and `check` verify provenance offline after one online run.
 */
export async function loadAttestations(root: string, name: string, version: string, options: AttestationOptions): Promise<AttestationLookup> {
  const cached = attestationCachePath(root, name, version);
  try {
    const hit = readJsonSync(cached);
    if (hit) return { status: "found", attestations: hit, source: "cache" };
  } catch {
    // A corrupt cache entry is refetched.
  }
  if (!options.network) {
    return { status: "missing", reason: "no cached npm provenance, and the network isn't allowed" };
  }
  const settings = readNpmrc(root, options.env);
  const base = registryFor(settings, name);
  const url = `${base}-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`;
  const headers: Record<string, string> = { accept: "application/json" };
  const token = tokenFor(settings, base);
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (response.status === 404) return { status: "missing", reason: "the registry has no attestations for this version" };
    if (!response.ok) return { status: "missing", reason: `the registry answered ${response.status}` };
    const body = await response.json();
    await writeFileAtomic(cached, `${JSON.stringify(body)}\n`);
    return { status: "found", attestations: body, source: "registry" };
  } catch (e) {
    return { status: "missing", reason: `the registry couldn't be reached (${(e as Error).message})` };
  }
}
