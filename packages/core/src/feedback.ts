import { readFileSync } from "node:fs";
import path from "node:path";
import { SdkError, error } from "./diagnostics.ts";
import { resolveInside } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export const FEEDBACK_KINDS = ["false-positive", "missed-violation", "unclear-guidance", "agent-ignored-rule"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackRequest {
  /** `<pack>#<rule>` or `local#<rule>`. */
  rule: string;
  kind: FeedbackKind;
  message: string;
  /** Lines the reporter chooses to include, such as `src/app.tsx:10-14`. */
  lines?: string[];
  sdkVersion: string;
}

export interface FeedbackReport {
  reportVersion: 1;
  pack: string;
  packVersion?: string;
  packDigest?: string;
  rule: string;
  kind: FeedbackKind;
  message: string;
  facts: { bundler: string; moduleFederation: string; role: string };
  sdkVersion: string;
  lines?: Array<{ file: string; start: number; end: number; text: string }>;
}

export interface FeedbackResult {
  report: FeedbackReport;
  /** The pack's feedback link, with the report filled in when the channel accepts it. */
  link: string;
  prefilled: boolean;
}

function parseLines(root: string, spec: string) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(spec);
  if (!m) throw new SdkError("usage", `--lines takes <file>:<start>[-<end>], not ${JSON.stringify(spec)}`);
  const file = m[1]!;
  const start = Number(m[2]);
  const end = Number(m[3] ?? m[2]);
  const abs = resolveInside(root, file);
  if (!abs) throw new SdkError("usage", `${file} is outside the repo`);
  const all = readFileSync(abs, "utf8").split(/\r?\n/);
  if (start < 1 || end < start || end - start > 200) throw new SdkError("usage", `Line range ${spec} must be 1 to 201 lines`);
  return { file: path.posix.normalize(file), start, end, text: all.slice(start - 1, end).join("\n") };
}

/**
 * `feedback`: builds a report for a rule's owner. It includes file contents
 * only for lines the reporter names.
 */
export function createFeedback(ws: Workspace, req: FeedbackRequest): FeedbackResult {
  if (!(FEEDBACK_KINDS as readonly string[]).includes(req.kind)) {
    throw new SdkError("usage", `--kind must be one of ${FEEDBACK_KINDS.join(", ")}`);
  }
  if (!req.message?.trim()) throw new SdkError("usage", "Pass --message with the reason for the report");
  const hash = req.rule.lastIndexOf("#");
  if (hash <= 0) throw new SdkError("usage", `Name the rule as <pack>#<rule>, not ${JSON.stringify(req.rule)}`);
  const packRef = req.rule.slice(0, hash);
  const ruleId = req.rule.slice(hash + 1);
  const pack = ws.collection.packs.find((p) => p.ref === packRef);
  if (!pack) {
    throw new SdkError("usage", `No collected pack is named ${packRef}`, [error("feedback.pack", `No collected pack is named ${packRef}`)]);
  }
  if (!(pack.manifest.rules ?? []).some((r) => r.id === ruleId)) {
    throw new SdkError("usage", `${packRef} has no rule named ${ruleId}`);
  }
  const f = ws.facts.facts;
  const report: FeedbackReport = {
    reportVersion: 1,
    pack: packRef,
    ...(pack.version ? { packVersion: pack.version } : {}),
    ...(pack.ref !== "local" ? { packDigest: pack.manifestDigest } : {}),
    rule: ruleId,
    kind: req.kind,
    message: req.message.trim(),
    facts: { bundler: f.bundler, moduleFederation: f.moduleFederation, role: f.role },
    sdkVersion: req.sdkVersion,
  };
  if (req.lines?.length) report.lines = req.lines.map((l) => parseLines(ws.root, l));

  const channel = pack.manifest.feedback;
  const prefilled = channel.includes("{title}") || channel.includes("{body}");
  const title = `[${req.kind}] ${packRef}#${ruleId}`;
  const body = `${report.message}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
  const link = prefilled
    ? channel.replace("{title}", encodeURIComponent(title)).replace("{body}", encodeURIComponent(body))
    : channel;
  return { report, link, prefilled };
}
