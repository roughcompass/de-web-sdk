import { canonicalJson, sha256 } from "./util.ts";
import { createFeedback, type FeedbackRequest, type FeedbackReport } from "./feedback.ts";
import type { McpFeedbackTarget } from "./manifest.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Feedback adapters decide how a report reaches a pack's owner. Packs select
 * one by type and describe the target; the code is built into the SDK, so no
 * pack code ever handles a developer's credentials or network calls.
 * `jira` and `feature-request` are reached through an MCP server until the
 * enterprise chooses those systems.
 */
export const FEEDBACK_ADAPTER_TYPES = ["link", "mcp", "jira", "feature-request"] as const;
export type FeedbackAdapterType = (typeof FEEDBACK_ADAPTER_TYPES)[number];

export function isKnownAdapter(type: string): type is FeedbackAdapterType {
  return (FEEDBACK_ADAPTER_TYPES as readonly string[]).includes(type);
}

export interface FeedbackDraft {
  /** Binds the developer's approval to this exact content. */
  id: string;
  report: FeedbackReport;
  title: string;
  body: string;
  /** The pack's feedback link, filled in when it accepts the report. It's also the fallback. */
  link: string;
  prefilled: boolean;
  adapter: {
    type: string;
    /** Whether this SDK can submit through the adapter itself. */
    submits: boolean;
    /** Where the report goes, in words, for the developer to approve. */
    destination: string;
    mcp?: McpFeedbackTarget;
    /** Tool arguments with the report filled in. */
    arguments?: Record<string, string | number | boolean>;
  };
}

export type SubmissionResult =
  | { status: "submitted"; via: string; reference?: string; url?: string; response: string }
  | { status: "link"; reason: string; link: string; prefilled: boolean }
  | { status: "declined"; link: string; prefilled: boolean };

/** Calls a tool on an MCP server. The CLI package provides it, because it needs an MCP client. */
export type McpToolCaller = (target: McpFeedbackTarget, args: Record<string, string | number | boolean>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

/** Replaces `{name}` placeholders. Values stay as text; nothing is evaluated. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => (name in vars ? vars[name]! : whole));
}

/** Drafts a report and describes where the pack's adapter would send it. */
export function draftFeedback(ws: Workspace, req: FeedbackRequest): FeedbackDraft {
  const fb = createFeedback(ws, req);
  const pack = ws.collection.packs.find((p) => p.ref === fb.report.pack)!;
  const config = pack.manifest.feedbackAdapter ?? { type: "link" };
  const title = `[${fb.report.kind}] ${fb.report.pack}#${fb.report.rule}`;
  const body = `${fb.report.message}\n\n\`\`\`json\n${JSON.stringify(fb.report, null, 2)}\n\`\`\`\n`;
  const vars: Record<string, string> = {
    title,
    body,
    rule: `${fb.report.pack}#${fb.report.rule}`,
    ruleId: fb.report.rule,
    kind: fb.report.kind,
    message: fb.report.message,
    pack: fb.report.pack,
    packVersion: fb.report.packVersion ?? "",
    report: JSON.stringify(fb.report),
  };
  const known = isKnownAdapter(config.type);
  const viaMcp = known && config.type !== "link" && config.mcp;
  const args = viaMcp
    ? Object.fromEntries(Object.entries(config.mcp!.arguments ?? {}).map(([k, v]) => [k, typeof v === "string" ? fillTemplate(v, vars) : v]))
    : undefined;
  const destination = viaMcp
    ? `${config.type === "mcp" ? "" : `${config.type === "jira" ? "Jira" : "the feature request tool"}, through `}the MCP server ${JSON.stringify(config.mcp!.server)} (tool ${JSON.stringify(config.mcp!.tool)})`
    : known
      ? `the pack's feedback link, which you open to file the report`
      : `the pack's feedback link, because this SDK doesn't know the adapter type ${JSON.stringify(config.type)}`;
  const adapter: FeedbackDraft["adapter"] = { type: config.type, submits: Boolean(viaMcp), destination };
  if (viaMcp) {
    adapter.mcp = config.mcp;
    adapter.arguments = args;
  }
  const id = sha256(canonicalJson({ report: fb.report, adapter })).slice(0, 16);
  return { id, report: fb.report, title, body, link: fb.link, prefilled: fb.prefilled, adapter };
}

/**
 * Sends an approved draft through its adapter. When the adapter can't send,
 * the result carries the feedback link, so the developer can file it by hand.
 */
export async function submitFeedback(draft: FeedbackDraft, callTool: McpToolCaller | undefined): Promise<SubmissionResult> {
  const fallback = (reason: string): SubmissionResult => ({ status: "link", reason, link: draft.link, prefilled: draft.prefilled });
  if (!draft.adapter.submits || !draft.adapter.mcp) {
    return fallback(isKnownAdapter(draft.adapter.type) ? "the pack's feedback channel is a link; open it to file the report" : `this SDK doesn't know the adapter type ${JSON.stringify(draft.adapter.type)}`);
  }
  if (!callTool) return fallback("this command can't reach MCP servers");
  const result = await callTool(draft.adapter.mcp, draft.adapter.arguments ?? {});
  if (!result.ok) return fallback(result.reason);
  const url = /https?:\/\/[^\s"'<>)]+/.exec(result.text)?.[0];
  const reference = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(result.text)?.[0];
  return {
    status: "submitted",
    via: `MCP server ${draft.adapter.mcp.server}, tool ${draft.adapter.mcp.tool}`,
    ...(reference ? { reference } : {}),
    ...(url ? { url } : {}),
    response: result.text.slice(0, 2000),
  };
}
