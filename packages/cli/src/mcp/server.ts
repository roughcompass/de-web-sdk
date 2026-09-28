import { appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyObject } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  checkJson,
  checkText,
  draftFeedback,
  formatDiagnostic,
  formatJson,
  getSkill,
  isFile,
  loadWorkspace,
  MCP_SERVER_NAME,
  readPackFile,
  readVerified,
  resolveRules,
  runCheck,
  SdkError,
  skillUriPath,
  submitFeedback,
  walkFiles,
  type FeedbackDraft,
  type FeedbackKind,
  type SubmissionResult,
  type Workspace,
} from "@de-web-sdk/core";
import { mcpToolCaller, vscodeToolCaller } from "./client.ts";

export interface McpServerOptions {
  /** The repo root. Otherwise `CLAUDE_PROJECT_DIR`, the client's first root, then the working directory. */
  root?: string;
  env: NodeJS.ProcessEnv;
  rootKeys: KeyObject[];
  version: string;
}

/** Static, so the server starts without loading packs. Pack content reaches agents only through tools. */
export const INSTRUCTIONS = [
  "This server applies the web UI rules that this repo's packs publish.",
  "- Before editing files, call resolve with those files to get the rules, skills, docs, and commands that apply.",
  "- When a skill applies, load it with get_skill. Read its other files with read_pack_file. Don't read skill files from node_modules directly.",
  "- Before finishing, build if a rule reads build output, then call check. Apply each fix and call check again until it reports exit code 0.",
  "- Exit code 2 means the configuration is wrong, and 3 means a pack failed verification or a check couldn't run. Report either to the developer instead of working around it.",
  "- Never edit .de-web-sdk/ to silence a rule.",
  "- If a rule looks wrong, call draft_feedback. Review the draft with the developer when they're present, or approve it yourself when you act for them, then call submit_feedback.",
].join("\n");

const CHECK_AND_FIX = [
  "Check and fix the web UI rules for this change.",
  "1. Call resolve for the files you'll change, and follow each rule. Load any skill it lists with get_skill when the skill applies.",
  "2. Make the change. Build the repo if any rule reads build output.",
  "3. Call check. For each new violation, apply the fix it names, then call check again. Repeat until it reports exit code 0.",
  "4. Report exit code 2 or 3 to the developer instead of working around it.",
  "5. If a rule looks wrong, call draft_feedback with the reason. Review the draft with the developer when they're present, then call submit_feedback.",
].join("\n");

const DRAFT_TTL_MS = 30 * 60 * 1000;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const TOOLS = [
  {
    name: "resolve",
    title: "Rules for files",
    description: "Returns the rules, skills, reference docs, and pack commands that apply to the given files, or to the whole repo when given none. Call it before editing.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Repo-relative files you'll change" },
        rule: { type: "string", description: "One rule, as <pack>#<rule>" },
        pack: { type: "string", description: "One pack's rules" },
        format: { type: "string", enum: ["markdown", "json"] },
      },
    },
    annotations: readOnly,
  },
  {
    name: "check",
    title: "Check the rules",
    description: "Runs every applicable machine rule and explains each violation with its fix. With files, it counts only violations in those files. Exit code 0 means done.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Repo-relative files to count violations in" },
        format: { type: "string", enum: ["text", "json"] },
      },
    },
    annotations: readOnly,
  },
  {
    name: "get_skill",
    title: "Load a skill",
    description: "Returns a skill's instructions (SKILL.md) from its verified pack, and the files it can refer to.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "The skill's name, as resolve lists it" } }, required: ["name"] },
    annotations: readOnly,
  },
  {
    name: "read_pack_file",
    title: "Read a pack file",
    description: "Returns a file that a pack delivers, such as a skill's supporting file, a rule's guidance, or a reference doc, verified as it's served. Long files come in pages.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "A path that resolve or get_skill returned" }, offset: { type: "integer", minimum: 0 } },
      required: ["path"],
    },
    annotations: readOnly,
  },
  {
    name: "draft_feedback",
    title: "Draft feedback on a rule",
    description: "Drafts a report for a rule's owner and says where it would go. Nothing is sent until submit_feedback is called with the draft's id.",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "<pack>#<rule>, or local#<rule>" },
        kind: { type: "string", enum: ["false-positive", "missed-violation", "unclear-guidance", "agent-ignored-rule"] },
        message: { type: "string", description: "The developer's reason" },
        lines: { type: "array", items: { type: "string" }, description: "Lines the developer chooses to include, as <file>:<start>-<end>" },
      },
      required: ["rule", "kind", "message"],
    },
    annotations: readOnly,
  },
  {
    name: "submit_feedback",
    title: "Send feedback",
    description: "Sends a drafted report through the pack's feedback adapter. Calling it confirms the draft, for the developer or on their behalf. When it can't send, it returns the pack's feedback link.",
    inputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function failure(e: unknown): ToolResult {
  if (e instanceof SdkError) {
    const details = e.diagnostics.map(formatDiagnostic).join("\n");
    return text(`${e.message} (exit code ${e.exitCode})${details ? `\n${details}` : ""}`, true);
  }
  return text((e as Error)?.message ?? String(e), true);
}

/** Walks up to the folder that holds the SDK configuration or a package.json. */
function repoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (isFile(path.join(dir, ".de-web-sdk", "config.json")) || isFile(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function stamp(abs: string): string {
  try {
    const st = statSync(abs);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "-";
  }
}

/** Cheap signature of everything that changes the workspace: manifests, lockfiles, configuration, and packs. */
function fingerprint(root: string, ws?: Workspace): string {
  const files = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".de-web-sdk/config.json", ".de-web-sdk/trust.json", "node_modules/.package-lock.json", "node_modules/.modules.yaml"];
  const parts = files.map((f) => stamp(path.join(root, f)));
  for (const f of walkFiles(path.join(root, ".de-web-sdk", "local"))) parts.push(`${f}=${stamp(path.join(root, ".de-web-sdk", "local", f))}`);
  for (const p of ws?.collection.packs ?? []) parts.push(stamp(path.join(p.dir, "pack.json")));
  return parts.join("|");
}

/** Creates the SDK's MCP server: the same rules, checks, skills, and feedback as the CLI. */
export function createMcpServer(options: McpServerOptions): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version, title: "de-web-sdk" },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  let root: string | undefined;
  let cache: { fp: string; ws: Workspace } | undefined;
  let checks: Promise<unknown> = Promise.resolve();
  const drafts = new Map<string, { draft: FeedbackDraft; at: number }>();

  const getRoot = async (): Promise<string> => {
    if (root) return root;
    let base = options.root ?? options.env.CLAUDE_PROJECT_DIR;
    if (!base && server.getClientCapabilities()?.roots) {
      try {
        const listed = await server.listRoots();
        const first = listed.roots.find((r) => r.uri.startsWith("file://"));
        if (first) base = fileURLToPath(first.uri);
      } catch {
        // Fall back to the working directory.
      }
    }
    root = repoRoot(base ?? process.cwd());
    return root;
  };

  const load = async (fresh = false): Promise<Workspace> => {
    const r = await getRoot();
    if (!fresh && cache && cache.fp === fingerprint(r, cache.ws)) return cache.ws;
    const ws = await loadWorkspace({ root: r, rootKeys: options.rootKeys, network: false });
    cache = { fp: fingerprint(r, ws), ws };
    return ws;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));

  // DE_WEB_SDK_MCP_LOG names a file that records each tool call, for troubleshooting an agent tool's setup.
  const logFile = options.env.DE_WEB_SDK_MCP_LOG;
  const logCall = (name: string, result: ToolResult) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), tool: name, error: result.isError === true, bytes: result.content[0]?.text.length ?? 0 })}\n`);
    } catch {
      // Logging never breaks a tool call.
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResult> => {
    const result = await callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
    logCall(request.params.name, result);
    return result;
  });

  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      switch (name) {
        case "resolve": {
          const ws = await load();
          return text(resolveRules(ws, { files: args.files as string[] | undefined, rule: args.rule as string | undefined, pack: args.pack as string | undefined, format: args.format === "json" ? "json" : "markdown" }));
        }
        case "check": {
          // Checks always load fresh, so adapters only run from packs verified for this call.
          const run = checks.then(async () => {
            const ws = await load(true);
            const result = await runCheck(ws, { files: args.files as string[] | undefined });
            const ctx = { workspace: ws, result, sdkVersion: options.version };
            let body = args.format === "json" ? formatJson(checkJson(ctx)) : checkText(ctx);
            const budget = ws.config.resolveBudgetBytes;
            if (args.format !== "json" && Buffer.byteLength(body) > budget) {
              body = `${body.slice(0, budget - 200)}\n[Output trimmed to stay within ${Math.round(budget / 1024)} KiB. Call check with format json, or run \`npx --no de-web-sdk check --format json\`, for everything.]\n`;
            }
            return text(body, result.exitCode >= 2);
          });
          checks = run.catch(() => undefined);
          return await run;
        }
        case "get_skill": {
          const skill = getSkill(await load(), String(args.name ?? ""));
          const files = skill.files.map((f) => `- ${f.path} (${f.size} bytes)`).join("\n");
          return text(`${skill.content}\n\n---\nSkill ${skill.name} from ${skill.pack}. Read its files with read_pack_file:\n${files}\n`);
        }
        case "read_pack_file": {
          const page = readPackFile(await load(), String(args.path ?? ""), Number(args.offset ?? 0));
          return text(page.nextOffset !== undefined ? `${page.text}\n[More: call read_pack_file with offset ${page.nextOffset}.]` : page.text);
        }
        case "draft_feedback": {
          const ws = await load();
          const draft = draftFeedback(ws, { rule: String(args.rule ?? ""), kind: args.kind as FeedbackKind, message: String(args.message ?? ""), lines: args.lines as string[] | undefined, sdkVersion: options.version });
          drafts.set(draft.id, { draft, at: Date.now() });
          return text(
            [
              `Draft ${draft.id}. It goes to ${draft.adapter.destination}.`,
              "Review this report with the developer when they're present. Calling submit_feedback with the draft id sends it.",
              "",
              "```json",
              JSON.stringify(draft.report, null, 2),
              "```",
              `Fallback link: ${draft.link}`,
            ].join("\n"),
          );
        }
        case "submit_feedback": {
          const entry = drafts.get(String(args.draftId ?? ""));
          if (!entry || Date.now() - entry.at > DRAFT_TTL_MS) return text("No current draft has that id. Call draft_feedback again.", true);
          const { draft } = entry;
          // Calling this tool is the confirmation: the developer's, or an agent's acting for them.
          // Agent tools that ask before running open-world tools give the developer the choice.
          const result: SubmissionResult = await submitFeedback(
            draft,
            draft.adapter.submits ? mcpToolCaller({ root: await getRoot(), env: options.env, viaVsCode: vscodeToolCaller(options.env) }) : undefined,
          );
          drafts.delete(draft.id);
          if (result.status === "submitted") return text(`Sent through ${result.via}.${result.reference ? ` Reference: ${result.reference}.` : ""}${result.url ? ` ${result.url}` : ""}`);
          if (result.status === "declined") return text(`Not sent. It can still be filed at ${result.link}`);
          return text(`Not sent: ${result.reason}. It can be filed at ${result.link}`);
        }
        default:
          return text(`Unknown tool ${name}`, true);
      }
    } catch (e) {
      return failure(e);
    }
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts: Array<{ name: string; title?: string; description: string; arguments?: Array<{ name: string; description: string; required: boolean }> }> = [
      { name: "check-and-fix", title: "Check and fix", description: "Get the rules for a change, then check it and fix each violation.", arguments: [{ name: "files", description: "Files you'll change, separated by spaces", required: false }] },
    ];
    try {
      for (const s of (await load()).ruleSet.skills) prompts.push({ name: s.installName, description: s.description || `The ${s.name} skill from ${s.pack}.` });
    } catch {
      // A workspace that fails to load still offers the workflow prompt; its tools report the error.
    }
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    if (name === "check-and-fix") {
      const files = request.params.arguments?.files;
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: files ? `${CHECK_AND_FIX}\n\nFiles: ${files}` : CHECK_AND_FIX } }] };
    }
    const skill = getSkill(await load(), name);
    return {
      description: skill.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Follow this skill from ${skill.pack}. Read its files with read_pack_file.\n\n${skill.content}` } }],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Array<{ uri: string; name: string; description?: string; mimeType: string }> = [
      { uri: "de-web-sdk://rules", name: "Rules for this repo", mimeType: "text/markdown" },
    ];
    try {
      for (const s of (await load()).ruleSet.skills) resources.push({ uri: `skill://${s.installName}/SKILL.md`, name: s.installName, description: s.description, mimeType: "text/markdown" });
    } catch {
      // The rules resource reports the load error when read.
    }
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: "skill://{name}/{+path}", name: "Skill file", description: "A file in a skill, verified as it's served", mimeType: "text/plain" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const ws = await load();
    if (uri === "de-web-sdk://rules") return { contents: [{ uri, mimeType: "text/markdown", text: resolveRules(ws, { format: "markdown" }) }] };
    const rel = skillUriPath(ws, uri);
    const { text: body } = readVerified(ws, path.resolve(ws.root, rel));
    return { contents: [{ uri, mimeType: rel.endsWith(".md") ? "text/markdown" : "text/plain", text: body }] };
  });

  return server;
}

/** Runs the server over standard input and output until the client disconnects. */
export async function runMcpServer(options: McpServerOptions, transport?: Transport): Promise<void> {
  const server = createMcpServer(options);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  if (!transport) {
    // Stdio: the client ends the session by closing standard input or stopping the process.
    transport = new StdioServerTransport();
    process.stdin.once("end", () => void server.close());
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void server.close());
  }
  await server.connect(transport);
  await closed;
}
