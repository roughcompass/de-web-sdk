import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readLockfile, type Lockfile, type PackageManager } from "./lockfile.ts";
import { readPackageJson, type PackageJson } from "./resolve-package.ts";
import { isFile, readJsonSync } from "./util.ts";

export type Bundler = "vite" | "webpack" | "rspack" | "none" | "unknown";
export type ModuleFederation = "none" | "1" | "2" | "unknown";
export type Role = "host" | "remote" | "both" | "none" | "unknown";

/** Facts that conditions can test, as the pack-format spec defines them. */
export interface Facts {
  bundler: Bundler;
  bundlerVersion?: string;
  moduleFederation: ModuleFederation;
  role: Role;
  react?: string;
  /** Exact installed versions of the packages the SDK looked up. Unknown versions are absent. */
  packages: Record<string, string>;
}

export interface DeclaredFacts {
  bundler?: Exclude<Bundler, "unknown">;
  moduleFederation?: Exclude<ModuleFederation, "unknown">;
  role?: Exclude<Role, "unknown">;
  packages?: Record<string, string>;
}

export interface Disagreement {
  fact: string;
  declared: string;
  detected: string;
}

export interface FactReport {
  facts: Facts;
  detected: Facts;
  declared: DeclaredFacts;
  disagreements: Disagreement[];
  limitations: string[];
  packageManager: PackageManager;
  /** Workspace packages the SDK didn't evaluate. */
  notEvaluated: string[];
  /** Looks up a package's exact version, recording it in `facts.packages`. */
  versionOf(name: string): string | undefined;
}

export const MF2_PLUGINS = ["@module-federation/vite", "@module-federation/enhanced", "@module-federation/rsbuild-plugin", "@module-federation/rspack"];
const BUNDLERS: Array<{ name: "vite" | "rspack" | "webpack"; packages: string[]; configs: RegExp }> = [
  { name: "vite", packages: ["vite"], configs: /^vite\.config\.(c|m)?(j|t)s$/ },
  { name: "rspack", packages: ["@rspack/core", "@rspack/cli"], configs: /^rspack\.config\.(c|m)?(j|t)s$/ },
  { name: "webpack", packages: ["webpack", "webpack-cli"], configs: /^webpack\.config\.(c|m)?(j|t)s$/ },
];
const MANIFEST_LOCATIONS = ["dist/mf-manifest.json", "build/mf-manifest.json"];

/**
 * Detects facts by reading files. It never loads bundler configs or runs a
 * package manager's loader, as design D11 requires.
 */
export function detectFacts(root: string, declared: DeclaredFacts = {}): FactReport {
  const pkg: PackageJson = readPackageJson(root) ?? {};
  const lock: Lockfile = readLockfile(root);
  const limitations: string[] = [];
  if (lock.limitation) limitations.push(lock.limitation);
  const versionsReadable = !lock.limitation?.startsWith("Yarn Plug'n'Play");

  const declaredDeps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const ranges: Record<string, string> = { ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies };

  const packages: Record<string, string> = {};
  const looked = new Set<string>();
  const versionOf = (name: string): string | undefined => {
    if (looked.has(name)) return packages[name];
    looked.add(name);
    if (!versionsReadable) return undefined;
    const installed = readJsonSync<{ version?: string }>(path.join(root, "node_modules", ...name.split("/"), "package.json"))?.version;
    const version = installed ?? lock.lookup(name, ranges[name])?.version;
    if (version) packages[name] = version;
    return version;
  };
  for (const name of [...declaredDeps].sort()) versionOf(name);

  const rootFiles = safeReaddir(root);
  const configFiles = (re: RegExp) => rootFiles.filter((f) => re.test(f)).sort();

  let bundler: Bundler = "none";
  let bundlerConfigs: string[] = [];
  const byConfig = BUNDLERS.find((b) => configFiles(b.configs).length > 0);
  const byDep = BUNDLERS.find((b) => b.packages.some((p) => declaredDeps.has(p)));
  const chosen = byConfig ?? byDep;
  if (chosen) {
    bundler = chosen.name;
    bundlerConfigs = configFiles(chosen.configs);
  }
  const bundlerVersion = chosen ? chosen.packages.map(versionOf).find(Boolean) : undefined;

  const configText = [...configFiles(BUNDLERS[1]!.configs), ...configFiles(BUNDLERS[2]!.configs), ...bundlerConfigs]
    .filter((f, i, all) => all.indexOf(f) === i)
    .map((f) => readQuiet(path.join(root, f)))
    .join("\n");

  let moduleFederation: ModuleFederation = "none";
  if (MF2_PLUGINS.some((p) => declaredDeps.has(p))) moduleFederation = "2";
  else if (/\bModuleFederationPlugin\b/.test(configText)) moduleFederation = "1";

  let role: Role = moduleFederation === "none" ? "none" : "unknown";
  if (moduleFederation !== "none") {
    const manifest = MANIFEST_LOCATIONS.map((rel) => readJsonQuiet(path.join(root, rel))).find(Boolean) as
      | { exposes?: unknown[]; remotes?: unknown[] }
      | undefined;
    const allText = [configText, ...bundlerConfigs.map((f) => readQuiet(path.join(root, f)))].join("\n");
    const exposes = manifest ? nonEmpty(manifest.exposes) : hasEntries(allText, "exposes");
    const remotes = manifest ? nonEmpty(manifest.remotes) : hasEntries(allText, "remotes");
    if (exposes && remotes) role = "both";
    else if (exposes) role = "remote";
    else if (remotes) role = "host";
  }

  const detected: Facts = {
    bundler: !chosen && !versionsReadable ? "unknown" : bundler,
    moduleFederation,
    role,
    packages,
  };
  if (bundlerVersion) detected.bundlerVersion = bundlerVersion;
  const react = versionOf("react");
  if (react) detected.react = react;

  const facts: Facts = { ...detected, packages };
  const disagreements: Disagreement[] = [];
  for (const key of ["bundler", "moduleFederation", "role"] as const) {
    const value = declared[key];
    if (value === undefined) continue;
    if (detected[key] !== "unknown" && detected[key] !== value) {
      disagreements.push({ fact: key, declared: value, detected: detected[key] });
    }
    (facts as unknown as Record<string, string>)[key] = value;
  }
  if (declared.moduleFederation === "none" && declared.role === undefined) facts.role = "none";
  for (const [name, version] of Object.entries(declared.packages ?? {})) {
    const found = versionOf(name);
    if (found && found !== version) disagreements.push({ fact: `packages.${name}`, declared: version, detected: found });
    packages[name] = version;
  }
  if (declared.packages?.react) facts.react = declared.packages.react;

  return {
    facts,
    detected,
    declared,
    disagreements,
    limitations,
    packageManager: lock.manager,
    notEvaluated: workspacePackages(root, pkg),
    versionOf: (name) => (declared.packages?.[name] ?? versionOf(name)),
  };
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/** True when the config text sets `key` to a non-empty object or array. */
function hasEntries(text: string, key: string): boolean {
  const re = new RegExp(`\\b${key}\\s*:\\s*([\\[{])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[0].length).trimStart();
    if (!rest.startsWith(m[1] === "{" ? "}" : "]")) return true;
  }
  return false;
}

function workspacePackages(root: string, pkg: PackageJson): string[] {
  const patterns: string[] = [];
  const ws = pkg.workspaces as string[] | { packages?: string[] } | undefined;
  if (Array.isArray(ws)) patterns.push(...ws);
  else if (ws?.packages) patterns.push(...ws.packages);
  const pnpmWs = readQuiet(path.join(root, "pnpm-workspace.yaml"));
  for (const m of pnpmWs.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)) patterns.push(m[1]!);
  const out: string[] = [];
  for (const pattern of patterns) {
    const base = pattern.replace(/\/\*+$/, "");
    const dir = path.join(root, base);
    if (pattern.endsWith("*")) {
      for (const entry of safeReaddir(dir)) {
        if (isFile(path.join(dir, entry, "package.json"))) out.push(`${base}/${entry}`);
      }
    } else if (isFile(path.join(dir, "package.json"))) {
      out.push(base);
    }
  }
  return [...new Set(out)].sort();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readQuiet(abs: string): string {
  try {
    return existsSync(abs) ? readFileSync(abs, "utf8") : "";
  } catch {
    return "";
  }
}

function readJsonQuiet(abs: string): unknown {
  try {
    return readJsonSync(abs);
  } catch {
    return undefined;
  }
}
