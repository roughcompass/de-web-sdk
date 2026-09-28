import type { CheckResult } from "./check.ts";
import { scrubPaths } from "./scrub.ts";
import type { Workspace } from "./workspace.ts";

export const RECORD_SCHEMA_VERSION = 1;

/**
 * The resolution record: which packs, facts, exceptions, and ignored paths
 * applied to one `check` run, and its results. The pipeline stores it with
 * each build, so an auditor can read it without rerunning `check`.
 */
export function resolutionRecord(ws: Workspace, result: CheckResult, sdkVersion: string, now: Date = new Date()): unknown {
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    kind: "resolution-record",
    sdkVersion,
    createdAt: now.toISOString(),
    mode: result.mode,
    exitCode: result.exitCode,
    trustPolicy: ws.trust.enterprise ?? null,
    packs: ws.collection.packs.map((p) => ({
      id: p.ref,
      ...(p.version ? { version: p.version } : {}),
      kind: p.kind,
      via: p.via,
      ...(p.requiredBy ? { requiredBy: p.requiredBy } : {}),
      digest: p.manifestDigest,
      provenance: p.provenance ?? { method: "local" },
    })),
    skipped: ws.collection.skipped,
    facts: {
      effective: ws.facts.facts,
      detected: ws.facts.detected,
      declared: ws.facts.declared,
      disagreements: ws.facts.disagreements,
      limitations: ws.facts.limitations,
      notEvaluated: ws.facts.notEvaluated,
    },
    rules: ws.ruleSet.rules.map((r) => {
      const outcome = result.rules.find((o) => o.rule === r.ref);
      return {
        rule: r.ref,
        enforcement: r.enforcement,
        locked: r.locked,
        ...(outcome ? { status: outcome.status, violations: outcome.violations.filter((v) => v.state !== "excepted").length } : {}),
      };
    }),
    exclusions: ws.ruleSet.exclusions,
    exceptions: result.exceptions.map(({ index: _index, ...e }) => e),
    ignored: result.ignore,
    results: result.rules.flatMap((o) =>
      o.violations.map((v) => ({ rule: v.rule, file: v.file, ...(v.line ? { line: v.line } : {}), fingerprint: v.fingerprint, state: v.state })),
    ),
    adapterErrors: result.rules.filter((o) => o.status === "error").map((o) => ({ rule: o.rule, error: o.error })),
    overrides: ws.ruleSet.overrides,
  };
  return scrubPaths(record, ws.root);
}
