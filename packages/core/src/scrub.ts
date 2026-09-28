import os from "node:os";
import { realpathSync } from "node:fs";

/**
 * Removes absolute paths from strings in JSON output: the repo root becomes
 * `.`, and the home directory becomes `~`. JSON output never carries
 * absolute paths.
 */
export function scrubPaths<T>(value: T, root: string): T {
  const roots = new Set([root]);
  try {
    roots.add(realpathSync(root));
  } catch {
    // The root may not exist in tests.
  }
  const home = os.homedir();
  const replacements = [...roots].sort((a, b) => b.length - a.length);
  const scrub = (s: string): string => {
    let out = s;
    for (const r of replacements) out = out.split(`${r}/`).join("").split(r).join(".");
    if (home && home !== "/") out = out.split(home).join("~");
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
