import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestOf, SdkError } from "@de-web-sdk/core";
import { computeDigests, contentDigest, loadSource, publishedFiles, taskDigest, type PackSource } from "../source.ts";
import { usesExpectedApis } from "./adoption.ts";
import { CACHE_DIR, writeRun, type RunRecord, type TrialRecord } from "./records.ts";
import { grade, newRunId, saveChanges } from "./runner.ts";
import { captureChanges, createWorktree, prepareCandidate, startDigest } from "./worktree.ts";

export const TRIAL_MARKER = ".de-web-sdk-trial.json";
/**
 * Guided trials open in VS Code, which asks the developer to trust each new
 * folder before Copilot's agent mode can run there. Keeping every trial under
 * one parent folder lets the developer trust that parent once.
 */
export const GUIDED_TRIALS_DIR = path.join(os.homedir(), ".de-web-sdk", "trials");

interface Marker {
  packageDir: string;
  task: string;
  model: string;
  prompt: string;
  candidateDigest: string;
  base: string;
  startedAt: string;
}

/**
 * Prepares a guided Copilot trial: a fresh worktree with the candidate pack,
 * which the VS Code extension opens in a new window for Copilot's agent mode.
 */
export async function prepareGuided(source: PackSource, taskId: string, model: string, env: NodeJS.ProcessEnv, now: Date = new Date()) {
  const entry = source.tasks.find(({ task }) => task.id === taskId);
  if (!entry) throw new SdkError("usage", `No eval task has id ${taskId}`);
  const digest = contentDigest(source.manifest, computeDigests(source, publishedFiles(source)));
  const candidate = await prepareCandidate(source, digest);
  const wt = await createWorktree(source, entry.task, candidate, env, env.DE_WEB_SDK_TRIALS_DIR ?? GUIDED_TRIALS_DIR);
  const marker: Marker = { packageDir: source.packageDir, task: taskId, model, prompt: entry.task.prompt, candidateDigest: digest, base: wt.base, startedAt: now.toISOString() };
  writeFileSync(path.join(wt.dir, TRIAL_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return { worktree: wt.dir, prompt: entry.task.prompt, task: taskId, model };
}

/**
 * Grades a guided trial when the developer marks it finished, and records it.
 * Guided trials appear beside harness results and never count toward the gate.
 */
export async function finishGuided(worktree: string, env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<TrialRecord> {
  const markerPath = path.join(worktree, TRIAL_MARKER);
  if (!existsSync(markerPath)) throw new SdkError("usage", `${worktree} isn't a guided trial worktree`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Marker;
  const source = loadSource(marker.packageDir);
  const task = source.tasks.find(({ task: t }) => t.id === marker.task)?.task;
  if (!task) throw new SdkError("usage", `The pack no longer has task ${marker.task}`);
  const runId = newRunId(now, source.dir);
  const cacheDir = path.join(source.dir, CACHE_DIR, runId.replace(/[:.]/g, "-"), "1");
  mkdirSync(cacheDir, { recursive: true });
  const wt = { dir: worktree, base: marker.base };
  const changes = captureChanges(wt);
  saveChanges(cacheDir, changes);
  const result = await grade(wt, task, { env, source }, cacheDir);
  const trial: TrialRecord = {
    id: `${runId}-1`,
    task: task.id,
    taskDigest: taskDigest(source, task),
    startDigest: startDigest(source, task),
    model: marker.model,
    modelId: marker.model,
    condition: "candidate",
    packDigest: marker.candidateDigest,
    environment: "local",
    driver: "copilot-guided",
    route: "vscode:copilot-agent-mode",
    toolVersion: "copilot-agent-mode",
    status: "completed",
    passed: result.passed,
    graders: result.graders,
    api: usesExpectedApis(task.expects, changes.files),
    retried: false,
    diffDigest: digestOf(changes.diff),
    durationMs: now.getTime() - Date.parse(marker.startedAt),
    guided: true,
  };
  const run: RunRecord = {
    schemaVersion: 1,
    kind: "eval-run",
    id: runId,
    createdAt: now.toISOString(),
    environment: "local",
    pack: { id: source.packageJson.name!, version: source.packageJson.version ?? "0.0.0", candidateDigest: marker.candidateDigest },
    trials: [trial],
  };
  await writeRun(source.dir, run);
  return trial;
}
