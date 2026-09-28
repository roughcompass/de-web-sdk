import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** A repo-relative path with forward slashes. Returns undefined when `abs` is outside `root`. */
export function relativeTo(root: string, abs: string): string | undefined {
  const rel = path.relative(root, abs);
  if (rel === "" ) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

/** Resolves `rel` inside `root`, refusing paths that escape it. */
export function resolveInside(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back.startsWith("..") || path.isAbsolute(back)) return undefined;
  return abs;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(data: string | Buffer): string {
  return `sha256:${sha256(data)}`;
}

export function fileDigest(abs: string): string {
  return digestOf(readFileSync(abs));
}

export function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

export function isDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export function readJsonSync<T = unknown>(abs: string): T | undefined {
  if (!existsSync(abs)) return undefined;
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

export async function readJson<T = unknown>(abs: string): Promise<T | undefined> {
  if (!existsSync(abs)) return undefined;
  return JSON.parse(await readFile(abs, "utf8")) as T;
}

/** Writes through a temporary file so readers never see a partial file. */
export async function writeFileAtomic(abs: string, data: string | Buffer, mode?: number): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await writeFile(tmp, data, mode === undefined ? undefined : { mode });
  await rename(tmp, abs);
}

/** Deterministic JSON: two-space indent, keys in insertion order, trailing newline. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Canonical JSON with sorted keys, for digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface WalkOptions {
  /** Directory names to skip anywhere in the tree. */
  skipDirs?: string[];
  followSymlinks?: boolean;
}

/** Lists files under `root` as sorted relative POSIX paths. */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const skip = new Set(options.skipDirs ?? []);
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isRegular = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          const st = statSync(abs);
          isDirectory = st.isDirectory();
          isRegular = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (skip.has(entry.name)) continue;
        visit(abs, childRel);
      } else if (isRegular) {
        out.push(childRel);
      }
    }
  };
  visit(root, "");
  return out.sort();
}

export function isSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Extensions of files that agents read as text. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml",
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".css", ".html", ".xml", ".sh",
]);

export function isTextFile(rel: string): boolean {
  const base = path.basename(rel);
  if (base === "LICENSE" || base === "README" || base === "CHANGELOG") return true;
  return TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

/** Today's date in UTC as YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
