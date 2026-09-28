import type { CheckResult, Violation } from "./check.ts";
import type { ResolvedRule } from "./compose.ts";
import { FINGERPRINT_KEY } from "./adapter.ts";
import { formatDiagnostic, type Diagnostic } from "./diagnostics.ts";
import { scrubPaths } from "./scrub.ts";
import { pluralize, quote } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export const CHECK_SCHEMA_VERSION = 1;

export interface CheckReportContext {
  workspace: Workspace;
  result: CheckResult;
  sdkVersion: string;
}

function ruleIndex(ws: Workspace): Map<string, ResolvedRule> {
  return new Map(ws.ruleSet.rules.map((r) => [r.ref, r]));
}

function ownerText(rule: ResolvedRule): string {
  return `${rule.owner.team}${rule.owner.contact ? ` (${rule.owner.contact})` : ""}`;
}

/** The feedback channel without its `{title}` and `{body}` placeholders. */
export function contestLink(channel: string): string {
  try {
    const url = new URL(channel);
    for (const [key, value] of [...url.searchParams.entries()]) if (/\{(title|body)\}/.test(value)) url.searchParams.delete(key);
    return url.toString().replace(/\?$/, "");
  } catch {
    return channel;
  }
}

/** How to contest a rule: its owner's feedback link, and the command that files a report. */
export function contest(rule: ResolvedRule): { link: string; command: string } {
  return { link: contestLink(rule.contest), command: `npx --no de-web-sdk feedback ${rule.ref} --kind false-positive --message "<reason>"` };
}

function contestText(rule: ResolvedRule): string {
  const c = contest(rule);
  return `${c.link}, or run \`${c.command}\``;
}

function location(v: Violation): string {
  return `${v.file}${v.line ? `:${v.line}${v.column ? `:${v.column}` : ""}` : ""}`;
}

/** Every violation with the six items the consumer-cli spec requires. */
function explained(ws: Workspace, v: Violation) {
  const rule = ruleIndex(ws).get(v.rule)!;
  return {
    rule: v.rule,
    owner: rule.owner,
    rationale: rule.rationale,
    file: v.file,
    line: v.line,
    column: v.column,
    message: v.message,
    fix: rule.fix ?? "See the rule's guidance: run `npx --no de-web-sdk resolve --rule " + rule.ref + "`",
    contest: contest(rule),
    fingerprint: v.fingerprint,
    state: v.state,
    ...(v.exception !== undefined ? { exception: v.exception } : {}),
  };
}

export function checkJson(ctx: CheckReportContext): unknown {
  const { workspace: ws, result } = ctx;
  const rules = ruleIndex(ws);
  const report = {
    schemaVersion: CHECK_SCHEMA_VERSION,
    kind: "check",
    sdkVersion: ctx.sdkVersion,
    mode: result.mode,
    exitCode: result.exitCode,
    summary: {
      newViolations: result.counts.new,
      baselined: result.counts.baselined,
      excepted: result.counts.excepted,
      adapterErrors: result.counts.adapterErrors,
      ignoredFiles: result.counts.ignoredFiles,
      staleBaselineEntries: result.baseline.stale.length,
    },
    violations: result.rules.flatMap((r) => r.violations.map((v) => explained(ws, v))),
    adapterErrors: result.rules.filter((r) => r.status === "error").map((r) => ({ rule: r.rule, error: r.error })),
    rules: result.rules.map((r) => ({
      rule: r.rule,
      enforcement: "machine",
      locked: rules.get(r.rule)?.locked ?? false,
      status: r.status,
      violations: r.violations.filter((v) => v.state !== "excepted").length,
      ignoredResults: r.ignored,
    })),
    advisory: result.advisory,
    exceptions: result.exceptions.map((e) => ({
      rule: e.rule,
      owner: e.owner,
      reason: e.reason,
      expires: e.expires,
      ...(e.paths ? { paths: e.paths } : {}),
      ...(e.approvedBy ? { approvedBy: e.approvedBy, approval: e.approval } : {}),
    })),
    ignored: result.ignore,
    baseline: {
      present: result.baseline.present,
      ...(result.baseline.written !== undefined ? { written: result.baseline.written } : {}),
      ...(result.baseline.pruned !== undefined ? { pruned: result.baseline.pruned } : {}),
      stale: result.baseline.stale,
      ...(result.baseline.shrinkOnly ? { shrinkOnly: result.baseline.shrinkOnly } : {}),
    },
    entryPoints: { stale: result.staleEntryPoints },
    overrides: ws.ruleSet.overrides,
    diagnostics: result.diagnostics,
  };
  return scrubPaths(report, ws.root);
}

export function checkText(ctx: CheckReportContext): string {
  const { workspace: ws, result } = ctx;
  const rules = ruleIndex(ws);
  const out: string[] = [];
  const c = result.counts;
  if (result.exitCode === 2) {
    out.push("de-web-sdk check: stopped on a configuration error, before running any rule.", "");
    for (const d of result.diagnostics) out.push(formatDiagnostic(d));
    out.push("", "Exit code 2.");
    return `${out.join("\n")}\n`;
  }
  out.push(
    `de-web-sdk check: ${result.mode} mode. ${pluralize(c.new, "new violation")}, ${c.baselined} baselined, ${c.excepted} covered by exceptions, ${pluralize(c.adapterErrors, "adapter error")}, ${pluralize(c.ignoredFiles, "file")} ignored.`,
  );
  const machine = result.rules.length;
  const advisory = result.advisory.length;
  out.push(`Ran ${pluralize(machine, "machine rule")}. ${pluralize(advisory, "advisory rule")} ${advisory === 1 ? "applies" : "apply"} to agents only.`);

  const newOnes = result.rules.flatMap((r) => r.violations.filter((v) => v.state === "new"));
  if (newOnes.length) {
    out.push("", result.mode === "enforce" ? "New violations (these fail the check):" : "Violations (report mode, so they don't fail the check):");
    for (const v of newOnes) {
      const rule = rules.get(v.rule)!;
      out.push(
        "",
        `  ${v.rule}${rule.locked ? " (locked)" : ""}`,
        `    Location: ${location(v)}`,
        `    Message: ${quote(v.message)}`,
        `    Owner: ${ownerText(rule)}`,
        `    Why: ${rule.rationale}`,
        `    Fix: ${rule.fix ?? `see \`npx --no de-web-sdk resolve --rule ${rule.ref}\``}`,
        `    Contest: ${contestText(rule)}`,
      );
    }
  }
  const errors = result.rules.filter((r) => r.status === "error");
  if (errors.length) {
    out.push("", result.mode === "enforce" ? "Rules that couldn't be evaluated (these fail the check):" : "Rules that couldn't be evaluated:");
    for (const r of errors) out.push(`  ${r.rule}: ${r.error}`);
  }
  if (c.baselined) out.push("", `${pluralize(c.baselined, "violation")} are in the baseline and don't fail the check.`);
  if (result.baseline.stale.length) {
    out.push("", `${pluralize(result.baseline.stale.length, "baseline entry", "baseline entries")} no longer match a violation. Run \`npx --no de-web-sdk check --prune-baseline\` to remove them:`);
    for (const e of result.baseline.stale) out.push(`  ${e.rule} in ${e.file}`);
  }
  if (result.baseline.written !== undefined) out.push("", `Recorded ${pluralize(result.baseline.written, "violation")} in .de-web-sdk/baseline.json.${result.mode === "enforce" ? " The repo is now in enforce mode." : ""}`);
  if (result.baseline.pruned) out.push("", `Removed ${pluralize(result.baseline.pruned, "stale baseline entry", "stale baseline entries")}.`);
  const shrink = result.baseline.shrinkOnly;
  if (shrink?.added.length) {
    out.push("", `The baseline gained ${pluralize(shrink.added.length, "entry", "entries")} that ${shrink.ref} doesn't have. Baselines can only shrink; fix these instead:`);
    for (const e of shrink.added) out.push(`  ${e.rule} in ${e.file}`);
  }
  if (result.exceptions.length) {
    out.push("", "Active exceptions:");
    for (const e of result.exceptions) {
      out.push(`  ${e.rule}${e.paths ? ` in ${e.paths.join(", ")}` : ""}: owner ${e.owner}, expires ${e.expires}. ${quote(e.reason)}${e.approvedBy ? ` Approved by ${e.approvedBy}: ${e.approval}` : ""}`);
    }
  }
  if (result.ignore.length) {
    out.push("", "Ignored paths (locked rules still apply):");
    for (const i of result.ignore) out.push(`  ${i.path}: ${pluralize(i.files, "file")}. ${quote(i.reason)}`);
  }
  for (const o of ws.ruleSet.overrides) {
    out.push("", `Eval gate override in ${o.pack} for ${o.model}: ${quote(o.reason)} Approved by ${o.approvedBy}, expires ${o.expires}.`);
  }
  const notes = result.diagnostics.filter((d) => d.severity !== "info" || d.code === "baseline.introduced");
  if (notes.length) {
    out.push("");
    for (const d of notes) out.push(formatDiagnostic(d));
  }
  out.push("", `Exit code ${result.exitCode}.`);
  return `${out.join("\n")}\n`;
}

export function checkSarif(ctx: CheckReportContext): unknown {
  const { workspace: ws, result } = ctx;
  const rules = ws.ruleSet.rules.filter((r) => r.enforcement === "machine");
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "de-web-sdk",
            version: ctx.sdkVersion,
            rules: rules.map((r) => ({
              id: r.ref,
              shortDescription: { text: r.title },
              fullDescription: { text: r.rationale },
              help: { text: r.fix ?? `Run npx --no de-web-sdk resolve --rule ${r.ref}` },
              properties: { owner: r.owner, locked: r.locked, contest: contest(r) },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: result.counts.adapterErrors === 0,
            toolExecutionNotifications: result.rules
              .filter((r) => r.status === "error")
              .map((r) => ({ level: "error", message: { text: r.error ?? "adapter error" }, associatedRule: { id: r.rule } })),
          },
        ],
        results: result.rules.flatMap((r) =>
          r.violations.map((v) => ({
            ruleId: v.rule,
            level: "error",
            message: { text: v.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: v.file },
                  ...(v.line ? { region: { startLine: v.line, ...(v.column ? { startColumn: v.column } : {}) } } : {}),
                },
              },
            ],
            partialFingerprints: { [FINGERPRINT_KEY]: v.fingerprint },
            baselineState: v.state === "baselined" ? "unchanged" : "new",
            ...(v.state === "excepted" ? { suppressions: [{ kind: "external", justification: ws.config.exceptions[v.exception!]?.reason ?? "" }] } : {}),
          })),
        ),
      },
    ],
  };
  return scrubPaths(sarif, ws.root);
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function checkJunit(ctx: CheckReportContext): string {
  const { workspace: ws, result } = ctx;
  const rules = ruleIndex(ws);
  const cases: string[] = [];
  let failures = 0;
  let errors = 0;
  for (const r of result.rules) {
    const rule = rules.get(r.rule)!;
    const pack = rule.pack;
    const newOnes = r.violations.filter((v) => v.state === "new");
    const time = (r.durationMs / 1000).toFixed(3);
    if (r.status === "error") {
      errors += 1;
      cases.push(`    <testcase classname="${xml(pack)}" name="${xml(r.rule)}" time="${time}">\n      <error message="${xml(r.error ?? "adapter error")}"/>\n    </testcase>`);
    } else if (newOnes.length) {
      failures += 1;
      const body = newOnes
        .map((v) => `${location(v)}: ${v.message}\nWhy: ${rule.rationale}\nFix: ${rule.fix ?? "see resolve"}\nOwner: ${ownerText(rule)}\nContest: ${contestText(rule)}`)
        .join("\n\n");
      cases.push(
        `    <testcase classname="${xml(pack)}" name="${xml(r.rule)}" time="${time}">\n      <failure message="${xml(pluralize(newOnes.length, "new violation"))}">${xml(body)}</failure>\n    </testcase>`,
      );
    } else {
      cases.push(`    <testcase classname="${xml(pack)}" name="${xml(r.rule)}" time="${time}"/>`);
    }
  }
  const total = result.rules.length;
  const doc = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="de-web-sdk check" tests="${total}" failures="${failures}" errors="${errors}">`,
    `  <testsuite name="de-web-sdk" tests="${total}" failures="${failures}" errors="${errors}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
  return scrubPaths(doc, ws.root);
}

export function diagnosticsJson(kind: string, exitCode: number, diagnostics: Diagnostic[], root: string, extra: Record<string, unknown> = {}): unknown {
  return scrubPaths({ schemaVersion: 1, kind, exitCode, ...extra, diagnostics }, root);
}
