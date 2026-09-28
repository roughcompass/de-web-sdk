import type { PackSource } from "../source.ts";
import type { GateResult } from "./gate.ts";
import type { EvalProfile } from "./profile.ts";
import { readReviews, type Condition, type RunRecord, type TrialRecord } from "./records.ts";
import { percent, rate } from "./stats.ts";

export interface ConditionStats {
  trials: number;
  passed: number;
  passRate: number;
  apiTrials: number;
  apiAdopted: number;
  apiRate: number | null;
}

export interface EvalReport {
  schemaVersion: 1;
  kind: "eval-report";
  pack: { id: string; version: string; candidateDigest: string; published?: { version: string; digest: string } };
  run: { id: string; createdAt: string; environment: string };
  models: Array<{
    alias: string;
    modelId: string;
    drivers: string[];
    routes: string[];
    toolVersions: string[];
    reportedModels: string[];
    conditions: Partial<Record<Condition, ConditionStats>>;
    tasks: Record<string, Partial<Record<Condition, ConditionStats>>>;
    changeFromPublished?: { pass: number; api: number | null };
  }>;
  guided: Array<{ task: string; alias: string; guided: ConditionStats; harness?: ConditionStats }>;
  disagreements: Array<{ trial: string; task: string; model: string; grader: string; verdict: string; reason: string }>;
  unsupportedClaims: { reviewed: number; withClaims: number; rate: number | null };
  coverage: string[];
  gate?: GateResult;
}

function stats(trials: TrialRecord[]): ConditionStats {
  const passed = trials.filter((t) => t.passed).length;
  const api = trials.filter((t) => t.api !== null);
  const adopted = api.filter((t) => t.api).length;
  return { trials: trials.length, passed, passRate: rate(passed, trials.length), apiTrials: api.length, apiAdopted: adopted, apiRate: api.length ? rate(adopted, api.length) : null };
}

const CONDITIONS: Condition[] = ["without", "candidate", "published"];

/** Builds the eval report for one run: both measures by model, condition, and task. */
export function buildReport(source: PackSource, run: RunRecord, allRuns: RunRecord[], gate?: GateResult): EvalReport {
  const { reviews } = readReviews(source.dir);
  const models: EvalReport["models"] = [];
  const aliases = [...new Set(run.trials.filter((t) => !t.guided).map((t) => t.model))].sort();
  for (const alias of aliases) {
    const trials = run.trials.filter((t) => t.model === alias && !t.guided);
    const conditions: EvalReport["models"][number]["conditions"] = {};
    for (const c of CONDITIONS) {
      const ts = trials.filter((t) => t.condition === c);
      if (ts.length) conditions[c] = stats(ts);
    }
    const tasks: EvalReport["models"][number]["tasks"] = {};
    for (const task of [...new Set(trials.map((t) => t.task))].sort()) {
      tasks[task] = {};
      for (const c of CONDITIONS) {
        const ts = trials.filter((t) => t.task === task && t.condition === c);
        if (ts.length) tasks[task]![c] = stats(ts);
      }
    }
    const entry: EvalReport["models"][number] = {
      alias,
      modelId: trials[0]?.modelId ?? alias,
      drivers: [...new Set(trials.map((t) => t.driver))],
      routes: [...new Set(trials.map((t) => `${t.environment}: ${t.route}`))],
      toolVersions: [...new Set(trials.map((t) => t.toolVersion))],
      reportedModels: [...new Set(trials.map((t) => t.reportedModel).filter((m): m is string => Boolean(m)))],
      conditions,
      tasks,
    };
    if (conditions.candidate && conditions.published) {
      entry.changeFromPublished = {
        pass: Math.round((conditions.candidate.passRate - conditions.published.passRate) * 100),
        api: conditions.candidate.apiRate !== null && conditions.published.apiRate !== null ? Math.round((conditions.candidate.apiRate - conditions.published.apiRate) * 100) : null,
      };
    }
    models.push(entry);
  }

  // Guided Copilot trials, beside the reference harness on the same tasks.
  const guidedTrials = allRuns.flatMap((r) => r.trials).filter((t) => t.guided && t.packDigest === run.pack.candidateDigest);
  const guided: EvalReport["guided"] = [];
  for (const key of [...new Set(guidedTrials.map((t) => `${t.task}\u0000${t.model}`))].sort()) {
    const [task, alias] = key.split("\u0000") as [string, string];
    const g = guidedTrials.filter((t) => t.task === task && t.model === alias);
    const harness = run.trials.filter((t) => !t.guided && t.task === task && t.model === alias && t.driver !== "claude-code" && t.condition === g[0]!.condition);
    guided.push({ task, alias, guided: stats(g), ...(harness.length ? { harness: stats(harness) } : {}) });
  }

  const byTrial = new Map(allRuns.flatMap((r) => r.trials).map((t) => [t.id, t]));
  const disagreements = reviews
    .filter((r) => byTrial.has(r.trial) && ((r.grader === "pass" && r.verdict === "disagree") || (r.grader === "fail" && r.verdict === "disagree")))
    .map((r) => ({ trial: r.trial, task: r.task, model: r.model, grader: r.grader, verdict: r.verdict, reason: r.reason }));
  const reviewed = reviews.filter((r) => byTrial.has(r.trial));
  const withClaims = reviewed.filter((r) => r.unsupportedClaims > 0).length;

  const covered = new Set(source.tasks.flatMap(({ task }) => task.exercises ?? []));
  const coverage = (source.manifest.rules ?? []).filter((r) => !covered.has(r.id)).map((r) => `No eval task exercises rule ${r.id}`);

  return {
    schemaVersion: 1,
    kind: "eval-report",
    pack: run.pack,
    run: { id: run.id, createdAt: run.createdAt, environment: run.environment },
    models,
    guided,
    disagreements,
    unsupportedClaims: { reviewed: reviewed.length, withClaims, rate: reviewed.length ? rate(withClaims, reviewed.length) : null },
    coverage,
    ...(gate ? { gate } : {}),
  };
}

function cell(s: ConditionStats | undefined, measure: "pass" | "api"): string {
  if (!s) return "-";
  return measure === "pass" ? percent(s.passed, s.trials) : s.apiTrials ? percent(s.apiAdopted, s.apiTrials) : "n/a";
}

export function reportText(report: EvalReport, profile?: EvalProfile): string {
  const out: string[] = [];
  out.push(`Eval report for ${report.pack.id} ${report.pack.version}, candidate ${report.pack.candidateDigest.slice(0, 19)}`);
  out.push(`Run ${report.run.id}, ${report.run.environment}.${report.pack.published ? ` Published version ${report.pack.published.version}.` : " No published version."}`);
  // Disagreements come first: they point owners at weak graders or unclear guidance.
  if (report.disagreements.length) {
    out.push("", "Trials where reviewers disagreed with graders:");
    for (const d of report.disagreements) out.push(`  ${d.trial} (${d.task}, ${d.model}): grader ${d.grader}, reviewer disagrees. ${JSON.stringify(d.reason)}`);
  }
  for (const m of report.models) {
    out.push("", `${m.alias} (${m.modelId}${m.reportedModels.length ? `; reported ${m.reportedModels.join(", ")}` : ""})${profile?.required.includes(m.alias) ? ", required" : ""}`);
    out.push(`  Ran in: ${m.routes.join("; ")}. Drivers: ${m.drivers.join(", ")}. Tool versions: ${m.toolVersions.join(", ")}.`);
    out.push("  Condition    Pass rate        API adoption");
    for (const c of CONDITIONS) {
      if (!m.conditions[c]) continue;
      out.push(`  ${c.padEnd(12)} ${cell(m.conditions[c], "pass").padEnd(16)} ${cell(m.conditions[c], "api")}`);
    }
    if (m.changeFromPublished) out.push(`  Change from published: pass ${m.changeFromPublished.pass >= 0 ? "+" : ""}${m.changeFromPublished.pass} points${m.changeFromPublished.api !== null ? `, API ${m.changeFromPublished.api >= 0 ? "+" : ""}${m.changeFromPublished.api} points` : ""}.`);
    out.push("  By task:");
    for (const [task, conds] of Object.entries(m.tasks)) {
      out.push(`    ${task}: ${CONDITIONS.filter((c) => conds[c]).map((c) => `${c} ${conds[c]!.passed}/${conds[c]!.trials}`).join(", ")}`);
    }
  }
  if (report.guided.length) {
    out.push("", "Guided Copilot trials (they don't count toward the gate):");
    for (const g of report.guided) out.push(`  ${g.task} on ${g.alias}: guided ${percent(g.guided.passed, g.guided.trials)}; reference harness ${g.harness ? percent(g.harness.passed, g.harness.trials) : "no trials"}`);
  }
  if (report.unsupportedClaims.reviewed) out.push("", `Unsupported claims: ${report.unsupportedClaims.withClaims} of ${report.unsupportedClaims.reviewed} reviewed trials.`);
  for (const c of report.coverage) out.push(`warning: ${c}`);
  if (report.gate) {
    out.push("", `Gate: ${report.gate.ok ? "passes" : "fails"}.`);
    for (const d of report.gate.decisions) {
      out.push(`  ${d.alias}: ${d.status}${d.reasons.length ? `. ${d.reasons.join(". ")}` : ""}${d.override ? `. Override by ${d.override.approvedBy} until ${d.override.expires}: ${JSON.stringify(d.override.reason)}` : ""}`);
    }
  }
  return `${out.join("\n")}\n`;
}
