import { readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { AdapterFacts } from "./adapter.ts";
import { staleEntryPoints } from "./agents.ts";
import { compareWithRef, entryKey, readBaseline, sortEntries, writeBaseline, type BaselineEntry } from "./baseline.ts";
import { matchesPaths, type ResolvedRule } from "./compose.ts";
import { CONFIG_FILE, exceptionIsActive, type RecordedException } from "./config.ts";
import { EXIT, error, info, warning, type Diagnostic, type ExitCode } from "./diagnostics.ts";
import { listRepoFiles } from "./git.ts";
import { runAdapter, type AdapterRun } from "./runner.ts";
import { formatJson, todayUtc, writeFileAtomic } from "./util.ts";
import { planFor, type Workspace } from "./workspace.ts";

export type ViolationState = "new" | "baselined" | "excepted";

export interface Violation {
  rule: string;
  file: string;
  line?: number;
  column?: number;
  /** The adapter's message. It can quote repo values, so text output quotes it as data. */
  message: string;
  fingerprint: string;
  state: ViolationState;
  /** The exception that covers it, by its index in the configuration. */
  exception?: number;
}

export interface RuleOutcome {
  rule: string;
  status: "passed" | "violated" | "error";
  error?: string;
  violations: Violation[];
  /** Results in ignored paths that were set aside. */
  ignored: number;
  durationMs: number;
}

export interface ActiveException extends RecordedException {
  index: number;
  locked: boolean;
}

export interface CheckOptions {
  /** Record every current violation in the baseline and exit with 0. */
  baseline?: boolean;
  /** With `baseline`, also switch the repo to enforce mode. */
  enforce?: boolean;
  pruneBaseline?: boolean;
  /** Repo-relative files. When set, only violations in these files count. */
  files?: string[];
  /** Base git ref for the shrink-only baseline check. */
  baselineRef?: string;
  now?: Date;
}

export interface CheckResult {
  mode: "report" | "enforce";
  exitCode: ExitCode;
  rules: RuleOutcome[];
  advisory: string[];
  counts: { new: number; baselined: number; excepted: number; adapterErrors: number; ignoredFiles: number };
  exceptions: ActiveException[];
  ignore: Array<{ path: string; reason: string; files: number }>;
  baseline: {
    present: boolean;
    written?: number;
    stale: BaselineEntry[];
    pruned?: number;
    shrinkOnly?: { ref: string; status: "introduced" | "compared" | "refMissing"; added: BaselineEntry[] };
  };
  staleEntryPoints: string[];
  diagnostics: Diagnostic[];
}

function adapterFacts(ws: Workspace): AdapterFacts {
  const f = ws.facts.facts;
  return { bundler: f.bundler, bundlerVersion: f.bundlerVersion, moduleFederation: f.moduleFederation, role: f.role, react: f.react, packages: { ...f.packages } };
}

/** Validates exceptions against the rule set. Expired and unapproved exceptions are configuration errors. */
export function reviewExceptions(ws: Workspace, today: string): { active: ActiveException[]; errors: Diagnostic[]; warnings: Diagnostic[] } {
  const active: ActiveException[] = [];
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const rules = new Map(ws.ruleSet.rules.map((r) => [r.ref, r]));
  ws.config.exceptions.forEach((e, index) => {
    const rule = rules.get(e.rule);
    const field = `exceptions[${index}]`;
    if (!exceptionIsActive(e, today)) {
      errors.push(error("exception.expired", `The exception for ${e.rule} expired on ${e.expires}. Its owner, ${e.owner}, must fix the violations or renew it`, { file: CONFIG_FILE, field }));
      return;
    }
    if (rule?.locked && (!e.approvedBy || !e.approval)) {
      errors.push(
        error(
          "exception.unapproved",
          `The exception for locked rule ${e.rule} needs "approvedBy" and "approval" from the rule's owner, ${rule.owner.team}${rule.owner.contact ? ` (${rule.owner.contact})` : ""}`,
          { file: CONFIG_FILE, field },
        ),
      );
      return;
    }
    if (!rule) warnings.push(warning("exception.unknownRule", `The exception for ${e.rule} matches no applicable rule`, { file: CONFIG_FILE, field }));
    active.push({ ...e, index, locked: rule?.locked === true });
  });
  return { active, errors, warnings };
}

function covering(exceptions: ActiveException[], rule: string, file: string): ActiveException | undefined {
  return exceptions.find((e) => e.rule === rule && (!e.paths?.length || picomatch(e.paths, { dot: true })(file)));
}

/**
 * `check`: runs every applicable machine rule and decides the exit code.
 * The workspace has already passed trust verification, so adapters only run
 * from verified packs.
 */
export async function runCheck(ws: Workspace, options: CheckOptions = {}): Promise<CheckResult> {
  const today = todayUtc(options.now);
  const diagnostics: Diagnostic[] = [...ws.warnings];
  const mode = options.baseline && options.enforce ? "enforce" : ws.config.mode;
  const result: CheckResult = {
    mode,
    exitCode: EXIT.ok,
    rules: [],
    advisory: ws.ruleSet.rules.filter((r) => r.enforcement === "advisory").map((r) => r.ref),
    counts: { new: 0, baselined: 0, excepted: 0, adapterErrors: 0, ignoredFiles: 0 },
    exceptions: [],
    ignore: [],
    baseline: { present: false, stale: [] },
    staleEntryPoints: [],
    diagnostics,
  };

  const exceptions = reviewExceptions(ws, today);
  diagnostics.push(...exceptions.warnings);
  if (exceptions.errors.length) {
    diagnostics.push(...exceptions.errors);
    result.exitCode = EXIT.config;
    return result;
  }
  result.exceptions = exceptions.active;

  let baseline: BaselineEntry[] | undefined;
  try {
    baseline = readBaseline(ws.root);
  } catch (e) {
    diagnostics.push(...((e as { diagnostics?: Diagnostic[] }).diagnostics ?? []));
    result.exitCode = EXIT.config;
    return result;
  }
  result.baseline.present = baseline !== undefined;
  const baselineKeys = new Set((baseline ?? []).map(entryKey));
  const named = options.files?.length ? new Set(options.files) : undefined;
  if (named && (options.baseline || options.pruneBaseline)) {
    diagnostics.push(error("usage.files", "--baseline and --prune-baseline cover the whole repo, so they don't take file arguments"));
    result.exitCode = EXIT.config;
    return result;
  }

  const files = listRepoFiles(ws.root);
  const ignoreMatchers = ws.config.ignore.map((i) => ({ ...i, match: picomatch(i.path, { dot: true }) }));
  const isIgnored = (file: string) => ignoreMatchers.some((m) => m.match(file));
  result.ignore = ignoreMatchers.map((m) => ({ path: m.path, reason: m.reason, files: files.filter((f) => m.match(f)).length }));
  result.counts.ignoredFiles = files.filter(isIgnored).length;

  const facts = adapterFacts(ws);
  const machine = ws.ruleSet.rules.filter((r) => r.enforcement === "machine");
  const runs = await mapLimit(
    machine,
    ADAPTER_CONCURRENCY,
    async (rule): Promise<[ResolvedRule, AdapterRun]> => {
      if (!rule.check) return [rule, { ok: false, error: "the rule declares no check", durationMs: 0 }];
      if (rule.check.unavailable || !rule.check.module) {
        return [rule, { ok: false, error: rule.check.unavailable ?? "the adapter can't be found", durationMs: 0 }];
      }
      const covered = files.filter((f) => matchesPaths(rule.paths, f) && (rule.locked || !isIgnored(f)));
      const run = await runAdapter({
        module: rule.check.module,
        root: ws.root,
        rule: rule.ref,
        facts,
        options: rule.check.options,
        files: covered,
        timeoutMs: ws.config.adapterTimeoutSeconds * 1000,
      });
      return [rule, run];
    },
  );

  const current: BaselineEntry[] = [];
  const succeeded = new Set<string>();
  for (const [rule, run] of runs) {
    const outcome: RuleOutcome = { rule: rule.ref, status: "passed", violations: [], ignored: 0, durationMs: run.durationMs };
    if (!run.ok) {
      outcome.status = "error";
      outcome.error = `${rule.check?.adapter ? `Adapter ${rule.check.pack}#${rule.check.adapter}` : "The check"}: ${run.error}`;
      result.counts.adapterErrors += 1;
      result.rules.push(outcome);
      continue;
    }
    succeeded.add(rule.ref);
    for (const w of run.warnings) diagnostics.push(warning("adapter.warning", `${rule.ref}: ${w}`));
    for (const finding of run.findings) {
      if (named && finding.file !== "." && !named.has(finding.file)) continue;
      if (rule.paths?.length && finding.file !== "." && !matchesPaths(rule.paths, finding.file)) continue;
      if (!rule.locked && isIgnored(finding.file)) {
        outcome.ignored += 1;
        continue;
      }
      const v: Violation = {
        rule: rule.ref,
        file: finding.file,
        line: finding.line,
        column: finding.column,
        message: finding.message,
        fingerprint: finding.fingerprint,
        state: "new",
      };
      const exception = covering(exceptions.active, rule.ref, finding.file);
      if (exception) {
        v.state = "excepted";
        v.exception = exception.index;
        result.counts.excepted += 1;
      } else {
        current.push({ rule: rule.ref, file: finding.file, fingerprint: finding.fingerprint });
        if (baselineKeys.has(entryKey({ rule: rule.ref, file: finding.file, fingerprint: finding.fingerprint }))) {
          v.state = "baselined";
          result.counts.baselined += 1;
        } else {
          result.counts.new += 1;
        }
      }
      outcome.violations.push(v);
    }
    outcome.violations.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.fingerprint.localeCompare(b.fingerprint));
    if (outcome.violations.some((v) => v.state === "new" || v.state === "baselined")) outcome.status = "violated";
    result.rules.push(outcome);
  }
  result.rules.sort((a, b) => a.rule.localeCompare(b.rule));

  // Stale baseline entries: rules that ran and no longer report them.
  const currentKeys = new Set(current.map(entryKey));
  result.baseline.stale = sortEntries((baseline ?? []).filter((e) => succeeded.has(e.rule) && !currentKeys.has(entryKey(e)) && (!named || named.has(e.file))));

  if (options.baseline) {
    if (result.counts.adapterErrors > 0) {
      diagnostics.push(error("baseline.incomplete", "The baseline wasn't written, because some checks couldn't run. Fix the adapter errors and rerun"));
      result.exitCode = EXIT.trust;
      return result;
    }
    await writeBaseline(ws.root, current);
    result.baseline.written = sortEntries(current).length;
    result.baseline.present = true;
    result.baseline.stale = [];
    for (const r of result.rules) for (const v of r.violations) if (v.state === "new") v.state = "baselined";
    result.counts.baselined += result.counts.new;
    result.counts.new = 0;
    if (options.enforce) await setMode(ws.root, "enforce");
    result.exitCode = EXIT.ok;
  } else if (options.pruneBaseline && baseline) {
    const staleKeys = new Set(result.baseline.stale.map(entryKey));
    const kept = baseline.filter((e) => !staleKeys.has(entryKey(e)));
    await writeBaseline(ws.root, kept);
    result.baseline.pruned = result.baseline.stale.length;
    result.baseline.stale = [];
  }

  if (options.baselineRef) {
    const working = readBaseline(ws.root) ?? [];
    const cmp = compareWithRef(ws.root, options.baselineRef, working);
    result.baseline.shrinkOnly = { ref: options.baselineRef, status: cmp.status, added: cmp.status === "compared" ? cmp.added : [] };
    if (cmp.status === "introduced") diagnostics.push(info("baseline.introduced", `${options.baselineRef} has no baseline, so this change introduces a new one`));
    if (cmp.status === "refMissing") {
      diagnostics.push(error("baseline.refMissing", `The base ref ${options.baselineRef} doesn't exist in this checkout. Fetch it, or pass a different --baseline-ref`));
      result.exitCode = EXIT.config;
      return result;
    }
  }

  try {
    result.staleEntryPoints = staleEntryPoints(ws.root, planFor(ws));
  } catch {
    result.staleEntryPoints = [];
  }
  if (result.staleEntryPoints.length) {
    diagnostics.push(warning("entryPoints.stale", `The committed agent entry points are out of date (${result.staleEntryPoints.join(", ")}). Run \`npx --no de-web-sdk sync\` and commit the result`));
  }

  if (options.baseline) return result;
  if (mode === "enforce") {
    if (result.counts.adapterErrors > 0) result.exitCode = EXIT.trust;
    else if (result.counts.new > 0) result.exitCode = EXIT.violations;
    else if (result.baseline.shrinkOnly?.added.length) result.exitCode = EXIT.violations;
  }
  return result;
}

const ADAPTER_CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Switches `mode` in the configuration file, keeping every other field. */
export async function setMode(root: string, mode: "report" | "enforce"): Promise<void> {
  const abs = path.join(root, CONFIG_FILE);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    data = {};
  }
  const next: Record<string, unknown> = { mode };
  for (const [k, v] of Object.entries(data)) if (k !== "mode") next[k] = v;
  await writeFileAtomic(abs, formatJson(next));
}
