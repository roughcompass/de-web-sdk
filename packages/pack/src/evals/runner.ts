import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestOf, MANIFEST_FILE, readManifestFile, SdkError } from "@de-web-sdk/core";
import { computeDigests, contentDigest, publishedFiles, taskDigest, validateEvals, type EvalTask, type PackSource } from "../source.ts";
import { usesExpectedApis } from "./adoption.ts";
import { getDriver } from "./drivers/index.ts";
import { Pacer, type Driver } from "./drivers/types.ts";
import { resolveFeedback } from "./feedback.ts";
import { coveredAliases, routeKey, type EvalProfile, type Route } from "./profile.ts";
import { CACHE_DIR, readRuns, RUNS_DIR, runFileName, writeRun, type Condition, type Environment, type RunRecord, type TrialRecord } from "./records.ts";
import { captureChanges, checkWorktree, createWorktree, prepareCandidate, prepareForGrading, removeWorktree, startDigest, type PreparedPack, type Worktree } from "./worktree.ts";

export interface RunOptions {
  source: PackSource;
  profile: EvalProfile;
  env: NodeJS.ProcessEnv;
  /** Run on the developer's own access, even where pipeline credentials exist. */
  local: boolean;
  yes: boolean;
  interactive: boolean;
  models?: string[];
  runs?: number;
  tasks?: string[];
  /** A published version, a directory, or a tarball. `false` skips the published condition. */
  published?: string | false;
  keep?: boolean;
  toolkitVersion: string;
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  now?: () => Date;
}

interface Plan {
  alias: string;
  modelId: string;
  route: Route;
  driver: Driver;
  toolVersion: string;
}

export const SDK_COMMANDS = ["resolve", "check", "skill"].flatMap((c) => [`npx --no de-web-sdk ${c} *`, `npx de-web-sdk ${c} *`, `de-web-sdk ${c} *`]);

export function allowedCommandsFor(task: EvalTask): string[] {
  // Agents see pack commands with the `npx --no` prefix, so both forms run.
  return [...SDK_COMMANDS, ...(task.build ? [task.build] : []), ...(task.commands ?? []).flatMap((c) => [c, `npx --no ${c}`])];
}

function environmentOf(options: RunOptions): Environment {
  if (options.local) return "local";
  return options.env.CI ? "pipeline" : "local";
}

/** Picks the first route that works where the runner is running. */
export async function chooseRoute(options: Pick<RunOptions, "profile" | "local" | "source" | "toolkitVersion" | "env">, alias: string, environment: Environment): Promise<Plan | { alias: string; reasons: string[] }> {
  const entry = options.profile.models[alias]!;
  const reasons: string[] = [];
  for (const route of entry.routes) {
    if (environment === "local" && route.endpoint && options.local) {
      reasons.push(`${routeKey(route)}: skipped for a local run`);
      continue;
    }
    let driver: Driver;
    try {
      driver = await getDriver(route, options.source.dir, options.toolkitVersion);
    } catch (e) {
      reasons.push(`${routeKey(route)}: ${(e as Error).message}`);
      continue;
    }
    const available = await driver.available(route, options.env);
    if (!available.ok) {
      reasons.push(`${routeKey(route)}: ${available.reason}`);
      continue;
    }
    return { alias, modelId: route.model ?? entry.model, route, driver, toolVersion: await driver.version(route, options.env) };
  }
  return { alias, reasons };
}

function extract(tarball: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dws-published-"));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return path.join(dir, "package");
}

/** Prepares the published version, from the registry or a local path. Returns undefined for a first version. */
function preparePublished(options: RunOptions): PreparedPack | undefined {
  if (options.published === false) return undefined;
  const id = options.source.packageJson.name!;
  let dir: string | undefined;
  const spec = options.published;
  try {
    if (spec && existsSync(spec)) dir = spec.endsWith(".tgz") ? extract(spec) : path.resolve(spec);
    else {
      const version = spec ?? execFileSync("npm", ["view", id, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: options.source.packageDir }).trim();
      if (!version) return undefined;
      const out = mkdtempSync(path.join(os.tmpdir(), "dws-published-"));
      const file = execFileSync("npm", ["pack", `${id}@${version}`, "--pack-destination", out, "--silent"], { encoding: "utf8", cwd: options.source.packageDir }).trim().split("\n").pop()!;
      dir = extract(path.join(out, file));
    }
  } catch {
    options.log(`No published version of ${id} was found, so the runner compares the candidate with the no-pack condition only.`);
    return undefined;
  }
  const packRel = path.relative(options.source.packageDir, options.source.dir);
  const read = readManifestFile(path.join(dir, packRel, MANIFEST_FILE));
  if (!read.manifest?.files) return undefined;
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
  return { id, version: pkg.version, dir, digest: contentDigest(read.manifest, read.manifest.files), trustKeys: [] };
}

/** The SDK version is part of the key, because the agent files and tools it gives agents change between versions. */
function reuseKey(t: Pick<TrialRecord, "task" | "taskDigest" | "startDigest" | "driver" | "route" | "modelId" | "toolVersion" | "packDigest"> & { sdkVersion?: string }): string {
  return [t.task, t.taskDigest, t.startDigest, t.driver, t.route, t.modelId, t.toolVersion, t.packDigest ?? "-", t.sdkVersion ?? "-"].join("\u0000");
}

export interface GradeResult {
  passed: boolean;
  graders: TrialRecord["graders"];
}

/** Grades a worktree: the task's build, then `check`, then the task's own scripts. */
export async function grade(wt: Worktree, task: EvalTask, options: Pick<RunOptions, "env" | "source">, cacheDir: string): Promise<GradeResult> {
  const env = { ...options.env, PATH: `${path.join(wt.dir, "node_modules", ".bin")}${path.delimiter}${options.env.PATH ?? ""}` };
  const graders: TrialRecord["graders"] = [];
  let built = true;
  let buildDetail: string | undefined;
  if (task.build) {
    try {
      execSync(task.build, { cwd: wt.dir, env, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
    } catch (e) {
      built = false;
      buildDetail = `the build failed: ${String((e as { stderr?: Buffer }).stderr ?? "").slice(-300)}`;
    }
  }
  for (const g of task.graders) {
    if (g.type === "check") {
      if (!built) {
        graders.push({ type: "check", passed: false, detail: buildDetail });
        continue;
      }
      const result = await checkWorktree(wt, options.env);
      writeFileSync(path.join(cacheDir, "check.json"), result.stdout);
      graders.push({ type: "check", passed: result.code === 0, ...(result.code === 0 ? {} : { detail: `check exited with ${result.code}` }) });
    } else {
      try {
        execSync(g.run, { cwd: options.source.dir, env: { ...env, DE_WEB_SDK_TRIAL_DIR: wt.dir }, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
        graders.push({ type: "script", passed: true });
      } catch (e) {
        // Graders usually print their reason to standard error, so keep both streams.
        const out = e as { stdout?: Buffer; stderr?: Buffer };
        graders.push({ type: "script", passed: false, detail: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim().slice(-300) });
      }
    }
  }
  return { passed: graders.length > 0 && graders.every((g) => g.passed), graders };
}

export function saveChanges(cacheDir: string, changes: ReturnType<typeof captureChanges>): void {
  writeFileSync(path.join(cacheDir, "diff.patch"), changes.diff);
  for (const f of changes.files) {
    const after = path.join(cacheDir, "after", f.path);
    mkdirSync(path.dirname(after), { recursive: true });
    writeFileSync(after, f.text);
    if (f.before !== undefined) {
      const before = path.join(cacheDir, "before", f.path);
      mkdirSync(path.dirname(before), { recursive: true });
      writeFileSync(before, f.before);
    }
  }
}

/** A run's identifier: its start time to the second, with a suffix when an earlier run started in the same second. */
export function newRunId(now: Date, packDir?: string): string {
  const base = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!packDir) return base;
  let id = base;
  for (let n = 2; existsSync(path.join(packDir, RUNS_DIR, runFileName(id))); n++) id = `${base}-r${n}`;
  return id;
}

/**
 * Runs a pack's evals: each task, on each model, in each condition, the
 * configured number of times. Reuses no-pack and published results that
 * still match, and asks before spending a developer's own quota.
 */
export async function runEvals(options: RunOptions): Promise<RunRecord> {
  const { source, profile } = options;
  const problems = validateEvals(source).filter((d) => d.severity === "error");
  if (problems.length) throw new SdkError("config", "The eval configuration has errors", problems);
  const config = source.evalConfig!;
  const now = options.now ?? (() => new Date());
  const environment = environmentOf(options);
  const files = computeDigests(source, publishedFiles(source));
  const candidateDigest = contentDigest(source.manifest, files);
  const runs = options.runs ?? config.runs;
  const tasks = source.tasks.filter(({ task }) => !options.tasks || options.tasks.includes(task.id));

  const aliases = coveredAliases(profile, config.models).filter((a) => !options.models || options.models.includes(a));
  const plans: Plan[] = [];
  for (const alias of aliases) {
    const plan = await chooseRoute(options, alias, environment);
    if ("reasons" in plan) {
      options.log(`${alias}: no route works here, so it gets no trials and the gate treats it as missing. ${plan.reasons.join("; ")}`);
      continue;
    }
    options.log(`${alias}: ${plan.modelId} via ${routeKey(plan.route)} (${plan.toolVersion})`);
    plans.push(plan);
  }
  if (!plans.length) throw new SdkError("usage", "No model in the eval profile is reachable here");

  const published = preparePublished(options);
  const candidate = await prepareCandidate(source, candidateDigest);
  // Local dependency packs, such as another pack in the workspace, install the same way for both versions.
  if (published) published.localPacks = candidate.localPacks;
  if (tasks[0]) {
    // A candidate that fails verification in a worktree would fail every trial, so check once first.
    try {
      removeWorktree(await createWorktree(source, tasks[0].task, candidate, options.env));
    } catch (e) {
      throw new SdkError("trust", `The candidate doesn't verify in a trial worktree, so no trial ran. ${(e as Error).message}`);
    }
  }
  if (published && tasks[0]) {
    // Trials install the published version with the pack repo's trust policy, so check it verifies before any trial runs.
    try {
      removeWorktree(await createWorktree(source, tasks[0].task, published, options.env));
    } catch (e) {
      throw new SdkError(
        "trust",
        `The published version ${published.version} doesn't verify with the trust policy in your pack repo's .de-web-sdk/trust.json. List your scope's key there, or extend the enterprise trust policy, or pass --published none. ${(e as Error).message}`,
      );
    }
  }
  const conditions: Condition[] = published ? ["without", "candidate", "published"] : ["without", "candidate"];

  // Reuse no-pack and published trials whose inputs haven't changed.
  const earlier = readRuns(source.dir).flatMap((r) => r.trials.map((t) => ({ ...t, reusedFrom: t.reusedFrom ?? r.id })));
  const pool = new Map<string, TrialRecord[]>();
  for (const t of earlier) {
    if (t.guided || t.condition === "candidate") continue;
    const k = reuseKey({ ...t, sdkVersion: (t as TrialRecord & { sdkVersion?: string }).sdkVersion });
    pool.set(k, [...(pool.get(k) ?? []), t]);
  }

  interface Job {
    plan: Plan;
    task: EvalTask;
    condition: Condition;
    reused?: TrialRecord;
    taskDigest: string;
    startDigest: string;
  }
  const jobs: Job[] = [];
  for (const plan of plans) {
    for (const { task } of tasks) {
      const tDigest = taskDigest(source, task);
      const sDigest = startDigest(source, task);
      for (const condition of conditions) {
        const packDigest = condition === "candidate" ? candidateDigest : condition === "published" ? published!.digest : null;
        const available = condition === "candidate" ? [] : [...(pool.get(reuseKey({ task: task.id, taskDigest: tDigest, startDigest: sDigest, driver: plan.driver.name, route: routeKey(plan.route), modelId: plan.modelId, toolVersion: plan.toolVersion, packDigest, sdkVersion: options.toolkitVersion })) ?? [])];
        for (let i = 0; i < runs; i++) jobs.push({ plan, task, condition, reused: available.shift(), taskDigest: tDigest, startDigest: sDigest });
      }
    }
  }

  const fresh = jobs.filter((j) => !j.reused);
  if (environment === "local" && fresh.length) {
    const byRoute = new Map<string, number>();
    for (const j of fresh) byRoute.set(`${j.plan.alias} via ${routeKey(j.plan.route)}`, (byRoute.get(`${j.plan.alias} via ${routeKey(j.plan.route)}`) ?? 0) + 1);
    const summary = [...byRoute.entries()].map(([k, n]) => `${k}: ${n}`).join(", ");
    const question = `This run starts ${fresh.length} trials on your own access and quota (${summary}), and reuses ${jobs.length - fresh.length}. Continue?`;
    if (!options.yes) {
      if (!options.interactive) throw new SdkError("usage", `${question} Pass --yes to confirm without a terminal`);
      if (!(await options.confirm(question))) throw new SdkError("usage", "Stopped before starting any trial");
    }
  }

  const runId = newRunId(now(), source.dir);
  const record: RunRecord = {
    schemaVersion: 1,
    kind: "eval-run",
    id: runId,
    createdAt: now().toISOString(),
    environment,
    pack: { id: source.packageJson.name!, version: source.packageJson.version ?? "0.0.0", candidateDigest, ...(published ? { published: { version: published.version, digest: published.digest } } : {}) },
    trials: [],
  };
  const pacers = new Map<string, Pacer>();
  let n = 0;
  for (const job of jobs) {
    if (job.reused) {
      record.trials.push(job.reused);
      continue;
    }
    n += 1;
    const id = `${runId}-${n}`;
    const cacheDir = path.join(source.dir, CACHE_DIR, runId.replace(/[:.]/g, "-"), String(n));
    mkdirSync(cacheDir, { recursive: true });
    const pack = job.condition === "candidate" ? candidate : job.condition === "published" ? published : undefined;
    const key = routeKey(job.plan.route);
    if (!pacers.has(key)) pacers.set(key, new Pacer(job.plan.route.requestsPerMinute ?? (job.plan.route.driver === "vscode" ? 20 : undefined)));
    const started = Date.now();
    const attempt = async () => {
      const wt = await createWorktree(source, job.task, pack, options.env);
      const outcome = await job.plan.driver.run({
        worktree: wt.dir,
        prompt: job.task.prompt,
        modelId: job.plan.modelId,
        route: job.plan.route,
        allowedCommands: allowedCommandsFor(job.task),
        timeoutMs: (job.task.timeoutSeconds ?? 600) * 1000,
        cacheDir,
        env: options.env,
        pacer: pacers.get(key)!,
      });
      return { wt, outcome };
    };
    let { wt, outcome } = await attempt();
    let retried = false;
    if (outcome.status === "error" && !outcome.acted) {
      // Retry once, only when the driver failed before the agent acted.
      removeWorktree(wt);
      retried = true;
      ({ wt, outcome } = await attempt());
    }
    const changes = captureChanges(wt);
    saveChanges(cacheDir, changes);
    const api = usesExpectedApis(job.task.expects, changes.files);
    let result: GradeResult = { passed: false, graders: [] };
    if (outcome.status === "completed") {
      if (job.condition !== "candidate") await prepareForGrading(wt, source, candidate, options.env);
      result = await grade(wt, job.task, options, cacheDir);
    } else {
      result.graders.push({ type: "agent", passed: false, detail: outcome.error });
    }
    const trial: TrialRecord = {
      id,
      task: job.task.id,
      taskDigest: job.taskDigest,
      startDigest: job.startDigest,
      model: job.plan.alias,
      modelId: job.plan.modelId,
      condition: job.condition,
      packDigest: pack?.digest ?? null,
      environment,
      driver: job.plan.driver.name,
      route: key,
      toolVersion: job.plan.toolVersion,
      ...(outcome.reportedModel ? { reportedModel: outcome.reportedModel } : {}),
      status: outcome.status,
      passed: result.passed,
      graders: result.graders,
      api,
      retried,
      diffDigest: digestOf(changes.diff),
      durationMs: Date.now() - started,
      ...(outcome.sdkUse && Object.keys(outcome.sdkUse).length ? { sdkUse: outcome.sdkUse } : {}),
      sdkVersion: options.toolkitVersion,
    } as TrialRecord;
    record.trials.push(trial);
    writeFileSync(path.join(cacheDir, "trial.json"), `${JSON.stringify({ ...trial, prompt: job.task.prompt, worktree: options.keep ? wt.dir : undefined }, null, 2)}\n`);
    options.log(`  trial ${n}/${fresh.length}: ${job.task.id}, ${job.plan.alias}: ${trial.passed ? "passed" : "failed"}${retried ? " (retried once)" : ""}`);
    if (!options.keep) removeWorktree(wt);
  }
  await writeRun(source.dir, record);
  await resolveFeedback(source, record, profile);
  ensureCacheIgnored(source.dir);
  return record;
}

/** Keeps raw prompts, transcripts, and diffs out of the pack's repo. */
export function ensureCacheIgnored(packDir: string): void {
  const file = path.join(packDir, "evals", ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!current.split("\n").includes(".cache/")) writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.cache/\n`);
}

export function cacheDirFor(packDir: string, trialId: string): string | undefined {
  const m = /^(.*Z)-(\d+)$/.exec(trialId);
  if (!m) return undefined;
  const dir = path.join(packDir, CACHE_DIR, m[1]!.replace(/[:.]/g, "-"), m[2]!);
  return existsSync(dir) ? dir : undefined;
}

export function listCachedFiles(dir: string, sub: "before" | "after"): string[] {
  const base = path.join(dir, sub);
  const out: string[] = [];
  const visit = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  visit(base, "");
  return out.sort();
}
