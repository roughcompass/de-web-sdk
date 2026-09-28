import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface LockEntry {
  version: string;
  /** Subresource integrity of the tarball, such as `sha512-...`, when the lockfile records it. */
  integrity?: string;
}

export interface Lockfile {
  manager: PackageManager;
  file?: string;
  /** Layouts the SDK can't read, such as Yarn Plug'n'Play. */
  limitation?: string;
  /** Looks up a direct or hoisted dependency. `range` picks the entry when the lockfile holds several. */
  lookup(name: string, range?: string): LockEntry | undefined;
}

const NONE: Lockfile = { manager: "unknown", lookup: () => undefined };

/** Reads the repo's lockfile without running any package manager code. */
export function readLockfile(root: string): Lockfile {
  const pnp = [".pnp.cjs", ".pnp.js"].find((f) => existsSync(path.join(root, f)));
  if (pnp) {
    return {
      manager: "yarn",
      file: "yarn.lock",
      limitation: `Yarn Plug'n'Play (${pnp}) keeps packages in archives, so exact versions can't be read without running its loader`,
      lookup: () => undefined,
    };
  }
  if (existsSync(path.join(root, "package-lock.json"))) return npmLock(root, "package-lock.json");
  if (existsSync(path.join(root, "npm-shrinkwrap.json"))) return npmLock(root, "npm-shrinkwrap.json");
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return pnpmLock(root);
  if (existsSync(path.join(root, "yarn.lock"))) return yarnLock(root);
  const bun = ["bun.lock", "bun.lockb"].find((f) => existsSync(path.join(root, f)));
  if (bun) {
    return { manager: "bun", file: bun, limitation: `Bun's lockfile (${bun}) isn't supported, so exact versions come only from installed packages`, lookup: () => undefined };
  }
  return NONE;
}

function npmLock(root: string, file: string): Lockfile {
  let data: { packages?: Record<string, { version?: string; integrity?: string }>; dependencies?: Record<string, { version?: string; integrity?: string }> };
  try {
    data = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  } catch {
    return { manager: "npm", file, limitation: `${file} couldn't be parsed`, lookup: () => undefined };
  }
  return {
    manager: "npm",
    file,
    lookup(name) {
      const entry = data.packages?.[`node_modules/${name}`] ?? data.dependencies?.[name];
      return entry?.version ? { version: entry.version, integrity: entry.integrity } : undefined;
    },
  };
}

function pnpmLock(root: string): Lockfile {
  let data: {
    importers?: Record<string, Record<string, Record<string, { version?: string } | string>>>;
    dependencies?: Record<string, { version?: string } | string>;
    devDependencies?: Record<string, { version?: string } | string>;
    packages?: Record<string, { resolution?: { integrity?: string }; version?: string }>;
  };
  try {
    data = parseYaml(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  } catch {
    return { manager: "pnpm", file: "pnpm-lock.yaml", limitation: "pnpm-lock.yaml couldn't be parsed", lookup: () => undefined };
  }
  const importer = data.importers?.["."] ?? { dependencies: data.dependencies ?? {}, devDependencies: data.devDependencies ?? {} };
  return {
    manager: "pnpm",
    file: "pnpm-lock.yaml",
    lookup(name) {
      for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const raw = importer[group]?.[name];
        if (!raw) continue;
        const spec = typeof raw === "string" ? raw : raw.version;
        if (!spec || spec.startsWith("link:") || spec.startsWith("file:")) return undefined;
        const version = spec.replace(/\(.*$/, "");
        const pkg = data.packages?.[`${name}@${version}`] ?? data.packages?.[`/${name}@${version}`] ?? data.packages?.[`/${name}/${version}`];
        return { version, integrity: pkg?.resolution?.integrity };
      }
      return undefined;
    },
  };
}

function yarnLock(root: string): Lockfile {
  const text = readFileSync(path.join(root, "yarn.lock"), "utf8");
  if (/^__metadata:/m.test(text)) return yarnBerryLock(text);
  // Yarn 1: blocks of `"name@range", name@range2:` followed by indented fields.
  const entries: Array<{ descriptors: string[]; version?: string; integrity?: string }> = [];
  let current: { descriptors: string[]; version?: string; integrity?: string } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      const header = line.replace(/:$/, "");
      current = { descriptors: header.split(/,\s*/).map((d) => d.replace(/^"|"$/g, "")) };
      entries.push(current);
    } else if (current) {
      const m = /^\s+(version|integrity)\s+"?([^"]+)"?$/.exec(line);
      if (m) current[m[1] as "version" | "integrity"] = m[2];
    }
  }
  return {
    manager: "yarn",
    file: "yarn.lock",
    lookup(name, range) {
      const matches = entries.filter((e) => e.descriptors.some((d) => descriptorName(d) === name));
      const exact = range ? matches.find((e) => e.descriptors.includes(`${name}@${range}`)) : undefined;
      const hit = exact ?? (matches.length === 1 ? matches[0] : undefined);
      return hit?.version ? { version: hit.version, integrity: hit.integrity } : undefined;
    },
  };
}

function yarnBerryLock(text: string): Lockfile {
  let data: Record<string, { version?: string; resolution?: string }>;
  try {
    data = parseYaml(text);
  } catch {
    return { manager: "yarn", file: "yarn.lock", limitation: "yarn.lock couldn't be parsed", lookup: () => undefined };
  }
  const entries = Object.entries(data)
    .filter(([key]) => key !== "__metadata")
    .map(([key, value]) => ({ descriptors: key.split(/,\s*/), version: value?.version }));
  return {
    manager: "yarn",
    file: "yarn.lock",
    lookup(name, range) {
      const matches = entries.filter((e) => e.descriptors.some((d) => descriptorName(d) === name));
      const exact = range ? matches.find((e) => e.descriptors.some((d) => d === `${name}@npm:${range}` || d === `${name}@${range}`)) : undefined;
      const hit = exact ?? (matches.length === 1 ? matches[0] : undefined);
      // Yarn Berry's checksum covers its own archive, not the npm tarball, so no integrity.
      return hit?.version ? { version: hit.version } : undefined;
    },
  };
}

function descriptorName(descriptor: string): string {
  const at = descriptor.indexOf("@", descriptor.startsWith("@") ? 1 : 0);
  return at === -1 ? descriptor : descriptor.slice(0, at);
}

/** The package manager a repo uses, from its lockfile, then its `packageManager` field. */
export function detectPackageManager(root: string, packageManagerField?: string): PackageManager {
  const lock = readLockfile(root);
  if (lock.manager !== "unknown") return lock.manager;
  const name = packageManagerField?.split("@")[0];
  if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") return name;
  return "npm";
}
