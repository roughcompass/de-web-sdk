import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { walkFiles } from "./util.ts";

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

export function isGitRepo(root: string): boolean {
  return existsSync(path.join(root, ".git")) || git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/**
 * Lists the repo's files as relative POSIX paths: tracked and untracked files
 * that git doesn't ignore, or every file outside `node_modules` and `.git`
 * when the directory isn't a git repo.
 */
export function listRepoFiles(root: string): string[] {
  if (isGitRepo(root)) {
    const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (out !== undefined) {
      return [...new Set(out.split("\0").filter(Boolean))].filter((f) => existsSync(path.join(root, f))).sort();
    }
  }
  return walkFiles(root, { skipDirs: ["node_modules", ".git"] });
}

/** Reads a file at a git ref. Returns undefined when the ref or file doesn't exist. */
export function showAtRef(root: string, ref: string, file: string): { found: true; text: string } | { found: false; refExists: boolean } {
  const refExists = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== undefined;
  if (!refExists) return { found: false, refExists };
  const text = git(root, ["show", `${ref}:${file}`]);
  return text === undefined ? { found: false, refExists } : { found: true, text };
}
