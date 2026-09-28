import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatJson, writeFileAtomic } from "@de-web-sdk/core";

export type Condition = "without" | "candidate" | "published";
export type Environment = "local" | "pipeline";

export interface TrialRecord {
  id: string;
  task: string;
  taskDigest: string;
  startDigest: string;
  model: string;
  modelId: string;
  condition: Condition;
  /** The digest of the pack the trial ran with, if any. */
  packDigest: string | null;
  environment: Environment;
  driver: string;
  route: string;
  toolVersion: string;
  reportedModel?: string;
  status: "completed" | "timeout" | "error";
  passed: boolean;
  graders: Array<{ type: string; passed: boolean; detail?: string }>;
  /** Whether the agent used every expected API. Null when the task declares none. */
  api: boolean | null;
  retried: boolean;
  diffDigest?: string;
  durationMs: number;
  /** Guided trials run in Copilot's own agent mode and don't count toward the gate. */
  guided?: boolean;
  /** The run this trial was first recorded in, when reused. */
  reusedFrom?: string;
  /** How often the agent called each SDK tool or command, such as `mcp:check` or `cli:resolve`. */
  sdkUse?: Record<string, number>;
  /** The SDK version that set up the trial. */
  sdkVersion?: string;
}

export interface RunRecord {
  schemaVersion: 1;
  kind: "eval-run";
  id: string;
  createdAt: string;
  environment: Environment;
  pack: { id: string; version: string; candidateDigest: string; published?: { version: string; digest: string } };
  trials: TrialRecord[];
}

export const RUNS_DIR = "evals/runs";
export const REVIEWS_DIR = "evals/reviews";
export const CACHE_DIR = "evals/.cache";

export function readRuns(packDir: string): RunRecord[] {
  const dir = path.join(packDir, RUNS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const name of names) {
    try {
      const run = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as RunRecord;
      if (run.kind === "eval-run") runs.push(run);
    } catch {
      // Skip unreadable records; the report lists the runs it read.
    }
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function runFileName(id: string): string {
  return `${id.replace(/[:.]/g, "-")}.json`;
}

export async function writeRun(packDir: string, run: RunRecord): Promise<string> {
  const rel = `${RUNS_DIR}/${runFileName(run.id)}`;
  await writeFileAtomic(path.join(packDir, rel), formatJson(run));
  return rel;
}

export interface ReviewRecord {
  task: string;
  model: string;
  condition: Condition;
  packDigest: string | null;
  trial: string;
  diffDigest?: string;
  grader: "pass" | "fail";
  reviewer: string;
  verdict: "agree" | "disagree";
  unsupportedClaims: number;
  reason: string;
  reviewedAt: string;
}

export interface ComparisonRecord {
  task: string;
  model: string;
  versions: { candidate: string; published: string };
  trials: { candidate: string; published: string };
  choice: "candidate" | "published" | "equal";
  reason: string;
  reviewer: string;
  reviewedAt: string;
}

export function readReviews(packDir: string): { reviews: ReviewRecord[]; comparisons: ComparisonRecord[] } {
  const dir = path.join(packDir, REVIEWS_DIR);
  const reviews: ReviewRecord[] = [];
  const comparisons: ComparisonRecord[] = [];
  const visit = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.name.endsWith(".json")) {
        try {
          const r = JSON.parse(readFileSync(abs, "utf8"));
          if (r.choice) comparisons.push(r);
          else if (r.verdict) reviews.push(r);
        } catch {
          // Skip unreadable reviews.
        }
      }
    }
  };
  visit(dir);
  return { reviews, comparisons };
}
