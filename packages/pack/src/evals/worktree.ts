import { execFileSync } from "node:child_process";
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createPrivateKey } from "node:crypto";
import { main as cli } from "@de-web-sdk/cli";
import { canonicalJson, digestOf, fileDigest, formatJson, MANIFEST_FILE, resolvePackageDir, SIGNATURE_FILE, walkFiles } from "@de-web-sdk/core";
import { computeDigests, contentDigest, loadSource, publishedFiles, type EvalTask, type PackSource } from "../source.ts";
import { generateKeys, signBytes } from "../sign.ts";

const require = createRequire(import.meta.url);

/** A pack ready to install into trial worktrees: an installed-package copy, signed with a throwaway key. */
export interface PreparedPack {
  id: string;
  version: string;
  /** Directory laid out as the installed package. */
  dir: string;
  digest: string;
  /** Trust policy entries that accept it. */
  trustKeys: string[];
  /** Where its own dependencies resolve from. */
  sourceDir?: string;
  dependencies?: string[];
  /** Packs it depends on that come from local source, such as a workspace, prepared the same way. */
  localPacks?: PreparedPack[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Builds the candidate as consumers would install it, with digests, signed by an ephemeral key. */
export async function prepareCandidate(source: PackSource, candidateDigest: string): Promise<PreparedPack> {
  const candidate = await preparePack(source, candidateDigest);
  candidate.localPacks = await prepareLocalDependencies(source, new Set([candidate.id]));
  return candidate;
}

function dependencyNames(pkg: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }): string[] {
  return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
}

/**
 * Packs the candidate depends on that resolve to local source rather than an
 * installed package, such as another pack in the same workspace. Their source
 * folders hold unpublished files and no signature, so trials install them
 * built and signed, as consumers would.
 */
async function prepareLocalDependencies(source: PackSource, seen: Set<string>): Promise<PreparedPack[]> {
  const out: PreparedPack[] = [];
  for (const dep of dependencyNames(source.packageJson)) {
    const dir = resolvePackageDir(source.packageDir, dep);
    if (!dir || seen.has(dep) || dir.split(path.sep).includes("node_modules")) continue;
    let depSource: PackSource;
    try {
      depSource = loadSource(dir);
    } catch {
      continue; // A local library that isn't a pack is linked as it is.
    }
    seen.add(dep);
    const prepared = await preparePack(depSource, contentDigest(depSource.manifest, computeDigests(depSource, publishedFiles(depSource))));
    out.push(prepared, ...(await prepareLocalDependencies(depSource, seen)));
  }
  return out;
}

async function preparePack(source: PackSource, digest: string): Promise<PreparedPack> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dws-candidate-"));
  const packageFiles = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: source.packageDir, encoding: "utf8" });
  const listed = (JSON.parse(packageFiles) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  for (const rel of listed) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    cpSync(path.join(source.packageDir, rel), path.join(dir, rel));
  }
  const packRel = path.relative(source.packageDir, source.dir);
  const packDir = path.join(dir, packRel);
  const files = computeDigests(source, publishedFiles(source));
  const manifest = { ...source.manifest, files };
  const bytes = Buffer.from(formatJson(manifest));
  writeFileSync(path.join(packDir, MANIFEST_FILE), bytes);
  const keys = generateKeys();
  writeFileSync(path.join(packDir, SIGNATURE_FILE), formatJson(await signBytes(bytes, createPrivateKey(keys.privatePem))));
  return {
    id: source.packageJson.name!,
    version: source.packageJson.version ?? "0.0.0",
    dir,
    digest,
    trustKeys: [keys.publicBase64],
    sourceDir: source.packageDir,
    dependencies: dependencyNames(source.packageJson),
  };
}

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Recreates the starting state's node_modules in the worktree as copy-on-write
 * clones where the file system supports them, and plain copies elsewhere.
 * Packages are then independent files inside the worktree, as in a consumer's
 * install. Salt's inspection refuses both symlinks that leave the repo and
 * hard-linked files, and an agent's edits can't reach the starting state.
 */
function linkModules(from: string, into: string, top: string = from): void {
  if (!existsSync(from)) return;
  mkdirSync(into, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(into, entry.name);
    if (exists(dst)) continue;
    if (entry.isDirectory()) {
      linkModules(src, dst, top);
    } else if (entry.isSymbolicLink()) {
      // Keep links within node_modules, such as .bin entries; point others at their real target.
      const link = readlinkSync(src);
      const target = path.resolve(path.dirname(src), link);
      const within = target === top || target.startsWith(top + path.sep);
      try {
        symlinkSync(within ? link : realpathSync(target), dst);
      } catch {
        // A broken link in the starting state; whatever needs it reports the missing file.
      }
    } else {
      copyFileSync(src, dst, constants.COPYFILE_FICLONE);
    }
  }
}

function copyPrepared(worktree: string, pack: PreparedPack): void {
  const target = path.join(worktree, "node_modules", ...pack.id.split("/"));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(pack.dir, target, { recursive: true });
}

function installPrepared(worktree: string, pack: PreparedPack, source: PackSource): void {
  const prepared = [pack, ...(pack.localPacks ?? [])];
  for (const p of prepared) copyPrepared(worktree, p);
  // The packs' own dependencies, such as adapter packs and libraries, come from the
  // producer repo, found the way Node.js finds them, so hoisted and workspace installs work too.
  for (const p of prepared) {
    const from = p.sourceDir ?? source.packageDir;
    for (const dep of p.dependencies ?? dependencyNames(source.packageJson)) {
      const src = resolvePackageDir(from, dep);
      const dst = path.join(worktree, "node_modules", ...dep.split("/"));
      if (src && !existsSync(dst)) {
        mkdirSync(path.dirname(dst), { recursive: true });
        symlinkSync(src, dst, "junction");
      }
    }
  }
  const pkgPath = path.join(worktree, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : { name: "eval-trial", private: true };
  pkg.devDependencies = { ...pkg.devDependencies, [pack.id]: pack.version };
  writeFileSync(pkgPath, formatJson(pkg));
  const producerTrust = path.join(source.packageDir, ".de-web-sdk", "trust.json");
  const trust = existsSync(producerTrust) ? JSON.parse(readFileSync(producerTrust, "utf8")) : { scopes: {} };
  trust.scopes = trust.scopes ?? {};
  for (const p of prepared) {
    const scope = p.id.startsWith("@") ? p.id.split("/")[0]! : "";
    trust.scopes[scope] = { ...trust.scopes[scope], keys: [...(trust.scopes[scope]?.keys ?? []), ...p.trustKeys] };
  }
  writeFileSync(path.join(worktree, ".de-web-sdk", "trust.json"), formatJson(trust));
}

function ensureConfig(worktree: string, mode: "enforce"): void {
  const file = path.join(worktree, ".de-web-sdk", "config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, formatJson({ ...config, mode }));
}

function cliBin(): string {
  return path.join(path.dirname(require.resolve("@de-web-sdk/cli/package.json")), "bin", "de-web-sdk.js");
}

async function runCli(worktree: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await cli(args, { cwd: worktree, env: { ...env, DE_WEB_SDK_OFFLINE: "1" }, stdout: (t) => (stdout += t), stderr: (t) => (stdout += t), interactive: false });
  return { code, stdout };
}

export interface Worktree {
  dir: string;
  base: string;
}

/**
 * Creates a fresh worktree from a task's starting state. With a pack, it
 * installs the pack and runs `sync` before the first commit, so the agent's
 * diff holds only its own changes.
 */
export async function createWorktree(source: PackSource, task: EvalTask, pack: PreparedPack | undefined, env: NodeJS.ProcessEnv, parent: string = os.tmpdir()): Promise<Worktree> {
  mkdirSync(parent, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(parent, "dws-trial-")));
  const start = path.join(source.dir, task.start);
  cpSync(start, dir, { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") });
  linkModules(path.join(start, "node_modules"), path.join(dir, "node_modules"));
  mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  if (!exists(path.join(dir, "node_modules", ".bin", "de-web-sdk"))) symlinkSync(cliBin(), path.join(dir, "node_modules", ".bin", "de-web-sdk"));
  // The .mcp.json entry that sync writes starts node_modules/@de-web-sdk/cli, so trials link it in.
  const cliTarget = path.join(dir, "node_modules", "@de-web-sdk", "cli");
  if (!existsSync(cliTarget)) {
    mkdirSync(path.dirname(cliTarget), { recursive: true });
    symlinkSync(path.dirname(path.dirname(cliBin())), cliTarget, "junction");
  }
  if (pack) {
    mkdirSync(path.join(dir, ".de-web-sdk"), { recursive: true });
    installPrepared(dir, pack, source);
    ensureConfig(dir, "enforce");
    const synced = await runCli(dir, ["sync"], env);
    if (synced.code !== 0) throw new Error(`sync failed in the trial worktree: ${synced.stdout.slice(0, 800)}`);
  }
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, ".git", "info", "exclude"), "node_modules/\n.de-web-sdk-trial.json\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=evals@de-web-sdk", "-c", "user.name=evals", "-c", "commit.gpgsign=false", "commit", "-qm", "start", "--allow-empty");
  return { dir, base: git(dir, "rev-parse", "HEAD").trim() };
}

export interface Changes {
  diff: string;
  files: Array<{ path: string; text: string; before?: string }>;
}

/** The agent's changes since the starting commit. */
export function captureChanges(wt: Worktree): Changes {
  git(wt.dir, "add", "-A");
  const diff = git(wt.dir, "diff", "--cached", "--binary", wt.base);
  const names = git(wt.dir, "diff", "--cached", "--name-only", "--diff-filter=AMR", wt.base).split("\n").filter(Boolean);
  const files = names.map((p) => {
    let before: string | undefined;
    try {
      before = git(wt.dir, "show", `${wt.base}:${p}`);
    } catch {
      before = undefined;
    }
    return { path: p, text: readFileSync(path.join(wt.dir, p), "utf8"), before };
  });
  return { diff, files };
}

/** Installs the candidate for grading, so every condition is graded by the same rules. */
export async function prepareForGrading(wt: Worktree, source: PackSource, candidate: PreparedPack, env: NodeJS.ProcessEnv): Promise<void> {
  mkdirSync(path.join(wt.dir, ".de-web-sdk"), { recursive: true });
  installPrepared(wt.dir, candidate, source);
  ensureConfig(wt.dir, "enforce");
  await runCli(wt.dir, ["sync"], env);
}

export async function checkWorktree(wt: Worktree, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return runCli(wt.dir, ["check", "--format", "json"], env);
}

export function removeWorktree(wt: Worktree): void {
  rmSync(wt.dir, { recursive: true, force: true });
}

/** The digest of a task's starting state, for reusing earlier results. */
export function startDigest(source: PackSource, task: EvalTask): string {
  const start = path.join(source.dir, task.start);
  const files = walkFiles(start, { skipDirs: ["node_modules", ".git"] });
  return digestOf(canonicalJson(files.map((f) => [f, fileDigest(path.join(start, f))])));
}
