import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatJson, SdkError, sha256, writeFileAtomic } from "@de-web-sdk/core";
import type { PackSource } from "../source.ts";
import { readReviews, readRuns, REVIEWS_DIR, type ComparisonRecord, type ReviewRecord, type TrialRecord } from "./records.ts";
import { cacheDirFor, listCachedFiles } from "./runner.ts";

/**
 * What a reviewer sees for one trial. It never includes the condition, the
 * pack digest, or anything else that reveals whether the pack was present.
 */
export interface BlindTrial {
  trial: string;
  task: string;
  prompt: string;
  grader: "pass" | "fail";
  graders: Array<{ type: string; passed: boolean }>;
  check?: string;
  diff?: string;
  cacheDir?: string;
  files: Array<{ path: string; before?: string; after: string }>;
}

function blind(source: PackSource, t: TrialRecord): BlindTrial {
  const dir = cacheDirFor(source.dir, t.id);
  const task = source.tasks.find((x) => x.task.id === t.task)?.task;
  const view: BlindTrial = {
    trial: t.id,
    task: t.task,
    prompt: task?.prompt ?? "",
    grader: t.passed ? "pass" : "fail",
    graders: t.graders.map((g) => ({ type: g.type, passed: g.passed })),
    files: [],
  };
  if (dir) {
    view.cacheDir = dir;
    const diff = path.join(dir, "diff.patch");
    if (existsSync(diff)) view.diff = readFileSync(diff, "utf8");
    const check = path.join(dir, "check.json");
    if (existsSync(check)) view.check = summarizeCheck(readFileSync(check, "utf8"));
    const before = new Set(listCachedFiles(dir, "before"));
    view.files = listCachedFiles(dir, "after").map((f) => ({ path: f, ...(before.has(f) ? { before: path.join(dir, "before", f) } : {}), after: path.join(dir, "after", f) }));
  }
  return view;
}

function summarizeCheck(text: string): string {
  try {
    const j = JSON.parse(text) as { summary?: { newViolations?: number; adapterErrors?: number }; violations?: Array<{ rule: string; file: string; message: string }> };
    const lines = [`${j.summary?.newViolations ?? 0} new violations, ${j.summary?.adapterErrors ?? 0} adapter errors`];
    for (const v of j.violations ?? []) lines.push(`${v.rule} in ${v.file}: ${v.message}`);
    return lines.join("\n");
  } catch {
    return text.slice(0, 2000);
  }
}

/** Trials without a review, in an order that doesn't group them by condition. */
export function reviewQueue(source: PackSource, runId?: string): BlindTrial[] {
  const runs = readRuns(source.dir);
  const run = runId ? runs.find((r) => r.id === runId) : runs.filter((r) => r.trials.some((t) => !t.reusedFrom)).at(-1);
  if (!run) return [];
  const reviewed = new Set(readReviews(source.dir).reviews.map((r) => r.trial));
  return run.trials
    .filter((t) => !t.reusedFrom && !reviewed.has(t.id))
    .sort((a, b) => sha256(a.id).localeCompare(sha256(b.id)))
    .map((t) => blind(source, t));
}

export interface ReviewInput {
  trial: string;
  verdict: "agree" | "disagree";
  reason: string;
  unsupportedClaims?: number;
  reviewer: string;
}

/** Stores a verdict. The condition is added only after the reviewer decides. */
export async function recordReview(source: PackSource, input: ReviewInput, now: Date = new Date()): Promise<ReviewRecord> {
  if (input.verdict !== "agree" && input.verdict !== "disagree") throw new SdkError("usage", "--verdict must be agree or disagree");
  if (!input.reason?.trim()) throw new SdkError("usage", "Give a reason with --reason");
  const trial = readRuns(source.dir).flatMap((r) => r.trials).find((t) => t.id === input.trial);
  if (!trial) throw new SdkError("usage", `No recorded trial has id ${input.trial}`);
  const record: ReviewRecord = {
    task: trial.task,
    model: trial.model,
    condition: trial.condition,
    packDigest: trial.packDigest,
    trial: trial.id,
    ...(trial.diffDigest ? { diffDigest: trial.diffDigest } : {}),
    grader: trial.passed ? "pass" : "fail",
    reviewer: input.reviewer,
    verdict: input.verdict,
    unsupportedClaims: input.unsupportedClaims ?? 0,
    reason: input.reason.trim(),
    reviewedAt: now.toISOString(),
  };
  await writeFileAtomic(path.join(source.dir, REVIEWS_DIR, trial.task, `${trial.id.replace(/[:.]/g, "-")}.json`), formatJson(record));
  return record;
}

export interface BlindPair {
  pair: string;
  task: string;
  model: string;
  prompt: string;
  a: BlindTrial;
  b: BlindTrial;
}

/** Candidate and published results for the same task and model, shown as A and B in a stable random order. */
export function comparisonQueue(source: PackSource): BlindPair[] {
  const run = readRuns(source.dir).filter((r) => r.pack.published).at(-1);
  if (!run) return [];
  const done = new Set(readReviews(source.dir).comparisons.map((c) => `${c.trials.candidate}|${c.trials.published}`));
  const out: BlindPair[] = [];
  const keys = [...new Set(run.trials.filter((t) => !t.guided).map((t) => `${t.task}\u0000${t.model}`))].sort();
  for (const key of keys) {
    const [task, model] = key.split("\u0000") as [string, string];
    const cand = run.trials.find((t) => t.task === task && t.model === model && t.condition === "candidate");
    const pub = run.trials.find((t) => t.task === task && t.model === model && t.condition === "published");
    if (!cand || !pub || done.has(`${cand.id}|${pub.id}`)) continue;
    const flip = sha256(`${cand.id}|${pub.id}`).charCodeAt(0) % 2 === 0;
    const [a, b] = flip ? [cand, pub] : [pub, cand];
    out.push({ pair: `${a.id}|${b.id}`, task, model, prompt: blind(source, a).prompt, a: blind(source, a), b: blind(source, b) });
  }
  return out;
}

export async function recordComparison(source: PackSource, input: { pair: string; choice: "A" | "B" | "equal"; reason: string; reviewer: string }, now: Date = new Date()): Promise<ComparisonRecord> {
  const [aId, bId] = input.pair.split("|");
  const runs = readRuns(source.dir);
  const run = runs.find((r) => r.trials.some((t) => t.id === aId));
  const a = run?.trials.find((t) => t.id === aId);
  const b = run?.trials.find((t) => t.id === bId);
  if (!run || !a || !b || !run.pack.published) throw new SdkError("usage", `No comparison pair ${input.pair}`);
  if (!input.reason?.trim()) throw new SdkError("usage", "Give a reason with --reason");
  const candidate = a.condition === "candidate" ? a : b;
  const published = a.condition === "candidate" ? b : a;
  const picked = input.choice === "equal" ? "equal" : (input.choice === "A" ? a : b).condition === "candidate" ? "candidate" : "published";
  const record: ComparisonRecord = {
    task: a.task,
    model: a.model,
    versions: { candidate: run.pack.version, published: run.pack.published.version },
    trials: { candidate: candidate.id, published: published.id },
    choice: picked,
    reason: input.reason.trim(),
    reviewer: input.reviewer,
    reviewedAt: now.toISOString(),
  };
  await writeFileAtomic(path.join(source.dir, REVIEWS_DIR, "comparisons", `${sha256(input.pair).slice(0, 12)}.json`), formatJson(record));
  return record;
}
