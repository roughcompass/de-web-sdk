import { realpathSync } from "node:fs";
import path from "node:path";
import { isFile, readJsonSync } from "./util.ts";

export interface PackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
  packageManager?: string;
  [key: string]: unknown;
}

/**
 * Finds an installed package the way Node.js does, by walking up
 * `node_modules` directories from `fromDir`. Reads files only.
 * Returns the package's real directory.
 */
export function resolvePackageDir(fromDir: string, name: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (isFile(path.join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readPackageJson(dir: string): PackageJson | undefined {
  try {
    return readJsonSync<PackageJson>(path.join(dir, "package.json"));
  } catch {
    return undefined;
  }
}

/** Dependencies and peer dependencies: the packages a pack may reference content in. */
export function declaredDependencies(pkg: PackageJson | undefined): Set<string> {
  return new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.peerDependencies ?? {}),
    ...Object.keys(pkg?.optionalDependencies ?? {}),
  ]);
}

export function binNames(pkg: PackageJson | undefined): string[] {
  if (!pkg?.bin) return [];
  if (typeof pkg.bin === "string") {
    const name = pkg.name?.split("/").pop();
    return name ? [name] : [];
  }
  return Object.keys(pkg.bin);
}
