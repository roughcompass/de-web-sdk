import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  digestOf,
  error,
  EMBED_FIELD,
  fileDigest,
  isDir,
  isFile,
  MANIFEST_FILE,
  readManifestFile,
  readPackageJson,
  SdkError,
  SIGNATURE_FILE,
  warning,
  type Diagnostic,
  type Manifest,
  type PackageJson,
} from "@de-web-sdk/core";

export interface EvalTask {
  id: string;
  prompt: string;
  start: string;
  build?: string;
  /** Extra commands the agent may run, such as the pack's own agent commands. */
  commands?: string[];
  exercises: string[];
  expects?: Array<{ package: string; export: string }>;
  graders: Array<{ type: "check" } | { type: "script"; run: string }>;
  timeoutSeconds?: number;
  /** The feedback report this task was drafted from. */
  feedbackReport?: string;
}

export interface EvalConfig {
  models: string[];
  runs: number;
  tasks: string[];
  overrides?: Array<{ model: string; reason: string; approvedBy: string; expires: string }>;
}

export interface PackSource {
  /** The producer repo's pack directory: where pack.json lives. */
  dir: string;
  /** The npm package root. Differs from `dir` for embedded packs. */
  packageDir: string;
  packageJson: PackageJson;
  manifest: Manifest;
  manifestText: string;
  embedded: boolean;
  evalConfig?: EvalConfig;
  tasks: Array<{ file: string; task: EvalTask }>;
}

export const EVALS_DIR = "evals";
export const EVAL_CONFIG = "evals/config.json";

/** Loads a pack's source repo. `dir` can be the package root of an embedding library. */
export function loadSource(dir: string): PackSource {
  const packageJson = readPackageJson(dir);
  if (!packageJson) throw new SdkError("usage", `No package.json in ${dir}`);
  let packDir = dir;
  let embedded = false;
  const field = packageJson[EMBED_FIELD];
  if (typeof field === "string") {
    packDir = path.resolve(dir, field);
    embedded = path.relative(dir, packDir) !== "";
    if (!isFile(path.join(packDir, MANIFEST_FILE))) {
      throw new SdkError("config", `package.json names ${JSON.stringify(field)} as the pack directory, but it holds no ${MANIFEST_FILE}`, [
        error("embed.missing", `The named pack directory ${JSON.stringify(field)} contains no ${MANIFEST_FILE}`, { file: "package.json", field: EMBED_FIELD }),
      ]);
    }
  }
  const read = readManifestFile(path.join(packDir, MANIFEST_FILE));
  if (!read.manifest || !read.bytes) throw new SdkError("config", read.diagnostics[0]?.message ?? "No pack.json", read.diagnostics);
  const source: PackSource = {
    dir: packDir,
    packageDir: dir,
    packageJson,
    manifest: read.manifest,
    manifestText: read.bytes.toString("utf8"),
    embedded,
    tasks: [],
  };
  const configPath = path.join(packDir, EVAL_CONFIG);
  if (existsSync(configPath)) {
    try {
      source.evalConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new SdkError("config", `${EVAL_CONFIG} isn't valid JSON: ${(e as Error).message}`);
    }
    for (const file of source.evalConfig?.tasks ?? []) {
      const abs = path.join(packDir, file);
      if (!existsSync(abs)) continue;
      try {
        source.tasks.push({ file, task: JSON.parse(readFileSync(abs, "utf8")) });
      } catch {
        // validateEvals reports unreadable tasks.
      }
    }
  }
  return source;
}

const CREDENTIAL_KEYS = /^(endpoint|url|baseUrl|base_url|apiKey|api_key|token|authToken|credentials?|secret|password)$/i;

function findCredentialKeys(value: unknown, trail: string, out: string[]) {
  if (Array.isArray(value)) value.forEach((v, i) => findCredentialKeys(v, `${trail}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = trail ? `${trail}.${k}` : k;
      if (CREDENTIAL_KEYS.test(k)) out.push(here);
      findCredentialKeys(v, here, out);
    }
  }
}

/** Validates eval configuration and tasks, and warns about rules no task exercises. */
export function validateEvals(source: PackSource): Diagnostic[] {
  const out: Diagnostic[] = [];
  const rules = source.manifest.rules ?? [];
  if (!rules.length) return out;
  if (!source.evalConfig) {
    out.push(error("evals.none", `A pack with rules needs at least one eval task. Add ${EVAL_CONFIG} and a task`, { file: EVAL_CONFIG }));
    return out;
  }
  const config = source.evalConfig;
  const leaked: string[] = [];
  findCredentialKeys(config, "", leaked);
  for (const f of leaked) out.push(error("evals.credentials", `Eval configuration can't hold endpoints or credentials (${f}). The platform's eval profile holds them`, { file: EVAL_CONFIG, field: f }));
  if (!Array.isArray(config.models)) out.push(error("evals.models", "models must list model aliases from the eval profile", { file: EVAL_CONFIG, field: "models" }));
  if (!Number.isInteger(config.runs) || config.runs < 1) out.push(error("evals.runs", "runs must be a positive whole number", { file: EVAL_CONFIG, field: "runs" }));
  if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
    out.push(error("evals.none", "A pack with rules needs at least one eval task", { file: EVAL_CONFIG, field: "tasks" }));
    return out;
  }
  config.tasks.forEach((file, i) => {
    if (!existsSync(path.join(source.dir, file))) out.push(error("evals.taskMissing", `Eval task file ${file} doesn't exist`, { file: EVAL_CONFIG, field: `tasks[${i}]` }));
  });
  const seen = new Set<string>();
  for (const { file, task } of source.tasks) {
    const leakedTask: string[] = [];
    findCredentialKeys(task, "", leakedTask);
    for (const f of leakedTask) out.push(error("evals.credentials", `Eval tasks can't hold endpoints or credentials (${f})`, { file, field: f }));
    const name = JSON.stringify(task.id ?? file);
    if (typeof task.id !== "string" || !task.id) out.push(error("evals.task", `Task in ${file} has no id`, { file, field: "id" }));
    else if (seen.has(task.id)) out.push(error("evals.task", `Task id ${name} is used twice`, { file, field: "id" }));
    else seen.add(task.id);
    if (typeof task.prompt !== "string" || !task.prompt.trim()) out.push(error("evals.task", `Task ${name} has no prompt`, { file, field: "prompt" }));
    if (typeof task.start !== "string" || !isDir(path.join(source.dir, task.start))) out.push(error("evals.task", `Task ${name}: its starting repo state ${JSON.stringify(task.start)} doesn't exist`, { file, field: "start" }));
    if (!Array.isArray(task.graders) || task.graders.length === 0) out.push(error("evals.grader", `Task ${name} has no grader`, { file, field: "graders" }));
    else {
      task.graders.forEach((g, i) => {
        if (g?.type !== "check" && !(g?.type === "script" && typeof (g as { run?: string }).run === "string")) {
          out.push(error("evals.grader", `Task ${name}: grader ${i} must be {"type":"check"} or {"type":"script","run":"<command>"}`, { file, field: `graders[${i}]` }));
        }
      });
      if (!task.graders.some((g) => g?.type === "check")) out.push(error("evals.grader", `Task ${name} needs a check grader, because every trial is graded by check`, { file, field: "graders" }));
    }
    if (!Array.isArray(task.exercises) || task.exercises.length === 0) out.push(error("evals.exercises", `Task ${name} must list the rules it exercises`, { file, field: "exercises" }));
    else {
      for (const r of task.exercises) {
        if (!rules.some((x) => x.id === r)) out.push(error("evals.exercises", `Task ${name} exercises ${JSON.stringify(r)}, which the pack doesn't define`, { file, field: "exercises" }));
      }
    }
    for (const [i, e] of (task.expects ?? []).entries()) {
      if (typeof e?.package !== "string" || typeof e.export !== "string") out.push(error("evals.expects", `Task ${name}: expects[${i}] needs package and export`, { file, field: `expects[${i}]` }));
    }
  }
  const covered = new Set(source.tasks.flatMap(({ task }) => task.exercises ?? []));
  for (const rule of rules) {
    if (!covered.has(rule.id)) out.push(warning("evals.uncovered", `No eval task exercises rule ${JSON.stringify(rule.id)}`, { file: EVAL_CONFIG, field: "tasks" }));
  }
  return out;
}

/** Files npm would publish, relative to the pack directory, from `npm pack --dry-run`. */
export function publishedFiles(source: PackSource): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: source.packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  const files = parsed[0]?.files.map((f) => f.path.split(path.sep).join("/")) ?? [];
  const prefix = source.embedded ? `${path.relative(source.packageDir, source.dir).split(path.sep).join("/")}/` : "";
  return files
    .filter((f) => !prefix || f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter((f) => f !== MANIFEST_FILE && f !== SIGNATURE_FILE)
    .sort();
}

export function computeDigests(source: PackSource, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = fileDigest(path.join(source.dir, f));
  return out;
}

/**
 * The digest of a pack's content: its manifest without generated fields, and
 * every published file. Eval results match a build when their candidate
 * digest equals this.
 */
export function contentDigest(manifest: Manifest, files: Record<string, string>): string {
  const { files: _files, evals: _evals, ...rest } = manifest;
  return digestOf(canonicalJson({ manifest: rest, files }));
}

export function taskDigest(source: PackSource, task: EvalTask): string {
  return digestOf(canonicalJson(task));
}

export { digestOf };
