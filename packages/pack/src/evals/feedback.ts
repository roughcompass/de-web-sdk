import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, FEEDBACK_KINDS, formatJson, SdkError, sha256, writeFileAtomic, type FeedbackReport } from "@de-web-sdk/core";
import { EVAL_CONFIG, type EvalTask, type PackSource } from "../source.ts";
import type { EvalProfile } from "./profile.ts";
import type { RunRecord } from "./records.ts";

export const FEEDBACK_DIR = "feedback";

export interface StoredFeedback {
  id: string;
  status: "open" | "resolved";
  importedAt: string;
  report: FeedbackReport;
  /** The eval task drafted from this report. */
  task?: string;
  resolvedIn?: string;
}

export function readFeedback(source: PackSource): StoredFeedback[] {
  const dir = path.join(source.dir, FEEDBACK_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")) as StoredFeedback);
}

async function save(source: PackSource, item: StoredFeedback): Promise<void> {
  await writeFileAtomic(path.join(source.dir, FEEDBACK_DIR, `${item.id}.json`), formatJson(item));
}

/** `feedback import`: stores a consumer's report in the pack's repo. */
export async function importFeedback(source: PackSource, raw: string, now: Date = new Date()): Promise<StoredFeedback> {
  let report: FeedbackReport;
  try {
    const text = raw.includes("```") ? (/```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1] ?? raw) : raw;
    report = JSON.parse(text);
  } catch {
    throw new SdkError("usage", "The feedback report isn't valid JSON");
  }
  if (report.reportVersion !== 1) throw new SdkError("usage", "Only version 1 feedback reports can be imported");
  if (report.pack !== source.manifest.id) throw new SdkError("usage", `The report is for ${report.pack}, not ${source.manifest.id}`);
  if (!(source.manifest.rules ?? []).some((r) => r.id === report.rule)) throw new SdkError("usage", `The pack has no rule named ${report.rule}`);
  if (!(FEEDBACK_KINDS as readonly string[]).includes(report.kind)) throw new SdkError("usage", `Unknown feedback kind ${report.kind}`);
  const id = sha256(canonicalJson(report)).slice(0, 10);
  const existing = readFeedback(source).find((f) => f.id === id);
  if (existing) return existing;
  const item: StoredFeedback = { id, status: "open", importedAt: now.toISOString(), report };
  await save(source, item);
  return item;
}

export function listOpenByRule(source: PackSource): Record<string, StoredFeedback[]> {
  const out: Record<string, StoredFeedback[]> = {};
  for (const f of readFeedback(source).filter((x) => x.status === "open")) (out[f.report.rule] ??= []).push(f);
  return out;
}

/** `eval add --from-feedback`: drafts an eval task that references the report's rule and message. */
export async function draftTaskFromFeedback(source: PackSource, id: string): Promise<{ file: string; task: EvalTask }> {
  const item = readFeedback(source).find((f) => f.id === id);
  if (!item) throw new SdkError("usage", `No imported feedback report has id ${id}`);
  const r = item.report;
  const start = source.tasks[0]?.task.start ?? "evals/fixtures/TODO";
  const task: EvalTask = {
    id: `feedback-${id}`,
    prompt: `TODO: write a task that reproduces this ${r.kind} report on rule ${r.rule}. Reporter's message: ${JSON.stringify(r.message)}`,
    start,
    exercises: [r.rule],
    graders: [{ type: "check" }],
    feedbackReport: id,
  };
  const file = `evals/tasks/feedback-${id}.json`;
  await writeFileAtomic(path.join(source.dir, file), formatJson(task));
  const configPath = path.join(source.dir, EVAL_CONFIG);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.tasks.includes(file)) config.tasks.push(file);
  await writeFileAtomic(configPath, formatJson(config));
  await save(source, { ...item, task: task.id });
  return { file, task };
}

/**
 * Marks reports resolved when the task drafted from them meets the profile's
 * pass threshold with the candidate on every required model.
 */
export async function resolveFeedback(source: PackSource, run: RunRecord, profile: EvalProfile): Promise<string[]> {
  const resolved: string[] = [];
  for (const item of readFeedback(source)) {
    if (item.status !== "open" || !item.task) continue;
    const ok = profile.required.every((alias) => {
      const trials = run.trials.filter((t) => t.task === item.task && t.model === alias && t.condition === "candidate" && !t.guided);
      return trials.length > 0 && trials.filter((t) => t.passed).length / trials.length >= profile.gate.resolveThreshold;
    });
    if (ok && profile.required.length) {
      await save(source, { ...item, status: "resolved", resolvedIn: run.id });
      resolved.push(item.id);
    }
  }
  return resolved;
}
