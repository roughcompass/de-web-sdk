import type { EvalSummaryEntry } from "@de-web-sdk/core";
import type { EvalConfig } from "../source.ts";
import { coveredAliases, type EvalProfile } from "./profile.ts";
import type { RunRecord, TrialRecord } from "./records.ts";
import { fisherLower, percent, rate } from "./stats.ts";

export interface MeasureResult {
  candidate: { successes: number; trials: number };
  without: { successes: number; trials: number };
  published?: { successes: number; trials: number };
  pValue: number;
  lower: boolean;
}

export interface AliasDecision {
  alias: string;
  required: boolean;
  status: "pass" | "fail" | "override";
  reasons: string[];
  run?: string;
  environment?: string;
  ranIn?: string;
  trialsPerCondition?: number;
  pass?: MeasureResult;
  api?: MeasureResult;
  override?: { reason: string; approvedBy: string; expires: string };
}

export interface GateResult {
  ok: boolean;
  decisions: AliasDecision[];
  summary: Record<string, EvalSummaryEntry>;
  overrides: Array<{ model: string; reason: string; approvedBy: string; expires: string }>;
}

function counts(trials: TrialRecord[], pick: (t: TrialRecord) => boolean | null) {
  const relevant = trials.map(pick).filter((v): v is boolean => v !== null);
  return { successes: relevant.filter(Boolean).length, trials: relevant.length };
}

function measure(candidate: TrialRecord[], without: TrialRecord[], published: TrialRecord[], pick: (t: TrialRecord) => boolean | null, alpha: number): MeasureResult | undefined {
  const c = counts(candidate, pick);
  const w = counts(without, pick);
  if (c.trials === 0 || w.trials === 0) return undefined;
  const pValue = fisherLower(c.successes, c.trials, w.successes, w.trials);
  const lower = c.successes / c.trials < w.successes / w.trials && pValue < alpha;
  const p = counts(published, pick);
  return { candidate: c, without: w, ...(p.trials ? { published: p } : {}), pValue, lower };
}

function ranIn(trials: TrialRecord[]): string {
  const routes = [...new Set(trials.map((t) => `${t.environment}, ${t.driver}${t.route.includes(":local") ? " with the developer's sign-in" : t.route.includes(":copilot") ? " in VS Code" : ""}`))];
  return routes.join("; ");
}

/**
 * The publish gate. For each required alias it uses the most recent run with
 * enough trials per condition, from one environment, and fails when either
 * measure is lower with the candidate than without the pack at the profile's
 * confidence level. Expiring overrides let an owner accept a result.
 */
export function evaluateGate(runs: RunRecord[], candidateDigest: string, profile: EvalProfile, config: EvalConfig | undefined, today: string): GateResult {
  const alpha = 1 - profile.gate.confidence;
  const min = profile.gate.minTrials;
  const aliases = coveredAliases(profile, config?.models);
  const decisions: AliasDecision[] = [];
  const summary: Record<string, EvalSummaryEntry> = {};
  const overrides: GateResult["overrides"] = [];

  for (const alias of aliases) {
    const required = profile.required.includes(alias);
    const decision: AliasDecision = { alias, required, status: "pass", reasons: [] };
    let best: { run: RunRecord; candidate: TrialRecord[]; without: TrialRecord[]; published: TrialRecord[] } | undefined;
    let fewest: { candidate: number; without: number } | undefined;
    for (const run of [...runs].reverse()) {
      const trials = run.trials.filter((t) => t.model === alias && !t.guided);
      const candidate = trials.filter((t) => t.condition === "candidate" && t.packDigest === candidateDigest);
      if (!candidate.length) continue;
      const without = trials.filter((t) => t.condition === "without");
      const published = trials.filter((t) => t.condition === "published");
      fewest ??= { candidate: candidate.length, without: without.length };
      if (candidate.length >= min && without.length >= min) {
        best = { run, candidate, without, published };
        break;
      }
    }
    if (!best) {
      decision.status = "fail";
      decision.reasons.push(
        fewest
          ? `${alias} has ${Math.min(fewest.candidate, fewest.without)} trials per condition (candidate ${fewest.candidate}, without the pack ${fewest.without}); the profile requires ${min}. Run \`de-web-sdk-pack eval run\` for more trials`
          : `No eval results match this pack's content for ${alias}. Run \`de-web-sdk-pack eval run\``,
      );
    } else {
      decision.run = best.run.id;
      decision.environment = best.run.environment;
      decision.ranIn = ranIn(best.candidate);
      decision.trialsPerCondition = Math.min(best.candidate.length, best.without.length);
      decision.pass = measure(best.candidate, best.without, best.published, (t) => t.passed, alpha);
      decision.api = measure(best.candidate, best.without, best.published, (t) => t.api, alpha);
      if (decision.pass?.lower) {
        decision.status = "fail";
        decision.reasons.push(`${alias}: the pass rate is lower with the candidate, ${percent(decision.pass.candidate.successes, decision.pass.candidate.trials)}, than without the pack, ${percent(decision.pass.without.successes, decision.pass.without.trials)} (p = ${decision.pass.pValue.toFixed(3)})`);
      }
      if (decision.api?.lower) {
        decision.status = "fail";
        decision.reasons.push(`${alias}: API adoption is lower with the candidate, ${percent(decision.api.candidate.successes, decision.api.candidate.trials)}, than without the pack, ${percent(decision.api.without.successes, decision.api.without.trials)} (p = ${decision.api.pValue.toFixed(3)})`);
      }
      const entry: EvalSummaryEntry = {
        trials: decision.trialsPerCondition,
        pass: {
          without: rate(decision.pass!.without.successes, decision.pass!.without.trials),
          with: rate(decision.pass!.candidate.successes, decision.pass!.candidate.trials),
          ...(decision.pass!.published ? { published: rate(decision.pass!.published.successes, decision.pass!.published.trials) } : {}),
        },
        ranIn: decision.ranIn,
      };
      if (decision.api) {
        entry.api = {
          without: rate(decision.api.without.successes, decision.api.without.trials),
          with: rate(decision.api.candidate.successes, decision.api.candidate.trials),
          ...(decision.api.published ? { published: rate(decision.api.published.successes, decision.api.published.trials) } : {}),
        };
      }
      summary[alias] = entry;
    }
    if (decision.status === "fail") {
      const override = config?.overrides?.find((o) => o.model === alias && o.expires >= today && o.reason && o.approvedBy);
      if (override) {
        decision.status = "override";
        decision.override = { reason: override.reason, approvedBy: override.approvedBy, expires: override.expires };
        overrides.push({ model: alias, reason: override.reason, approvedBy: override.approvedBy, expires: override.expires });
      }
    }
    // Only required aliases can fail the gate. Others are reported.
    if (!required && decision.status === "fail") decision.status = "pass";
    decisions.push(decision);
  }
  return { ok: decisions.every((d) => d.status !== "fail"), decisions, summary, overrides };
}
