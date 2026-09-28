import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseFrontmatter, resolveInside, walkFiles } from "@de-web-sdk/core";
import { commandAllowed, type TrialContext, type TrialOutcome } from "./types.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** A chat model with tool calling: an OpenAI-compatible endpoint, or Copilot's models through VS Code. */
export interface ModelClient {
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<{ message: ChatMessage; model?: string }>;
}

export const TOOLS: ToolSpec[] = [
  { type: "function", function: { name: "list_files", description: "List files under a directory in the repository.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file", description: "Read a file in the repository.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or replace a file in the repository.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run one allowed shell command in the repository root.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "finish", description: "Finish the task with a short summary.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

interface ScopedInstruction {
  file: string;
  match: (p: string) => boolean;
  body: string;
}

/**
 * Loads the repository instruction files that GitHub Copilot documents:
 * AGENTS.md, .github/copilot-instructions.md, path-scoped
 * .github/instructions/*.instructions.md, and project skills.
 */
export function loadCopilotContext(worktree: string): { always: string[]; scoped: ScopedInstruction[]; skills: Array<{ name: string; description: string; file: string }> } {
  const always: string[] = [];
  for (const rel of ["AGENTS.md", ".github/copilot-instructions.md"]) {
    const abs = path.join(worktree, rel);
    if (existsSync(abs)) always.push(`# ${rel}\n\n${readFileSync(abs, "utf8")}`);
  }
  const scoped: ScopedInstruction[] = [];
  const dir = path.join(worktree, ".github/instructions");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".instructions.md")).sort()) {
      const text = readFileSync(path.join(dir, name), "utf8");
      const fm = parseFrontmatter(text);
      const applyTo = typeof fm?.data.applyTo === "string" ? fm.data.applyTo : "**";
      scoped.push({ file: `.github/instructions/${name}`, match: picomatch(applyTo.split(",").map((s) => s.trim()), { dot: true }), body: fm?.body ?? text });
    }
  }
  // The project skill folders that VS Code's Copilot discovers.
  const skills: Array<{ name: string; description: string; file: string }> = [];
  for (const folder of [".github/skills", ".claude/skills", ".agents/skills"]) {
    const skillsDir = path.join(worktree, folder);
    if (!existsSync(skillsDir)) continue;
    for (const name of readdirSync(skillsDir).sort()) {
      const file = path.join(skillsDir, name, "SKILL.md");
      if (!existsSync(file) || skills.some((s) => s.name === name)) continue;
      const fm = parseFrontmatter(readFileSync(file, "utf8"));
      skills.push({ name: String(fm?.data.name ?? name), description: String(fm?.data.description ?? ""), file: `${folder}/${name}/SKILL.md` });
    }
  }
  return { always, scoped, skills };
}

interface SdkServer {
  client: Client;
  tools: ToolSpec[];
  instructions?: string;
}

const SDK_PREFIX = "mcp__de-web-sdk__";

/**
 * Starts the SDK's MCP server that the trial's `.mcp.json` names, the way
 * Copilot and Claude Code would, and offers its tools to the model. Trials
 * never get the tool that sends feedback.
 */
export async function startSdkServer(worktree: string, env: NodeJS.ProcessEnv): Promise<SdkServer | undefined> {
  const config = path.join(worktree, ".mcp.json");
  if (!existsSync(config)) return undefined;
  let entry: { command?: string; args?: string[] } | undefined;
  try {
    entry = (JSON.parse(readFileSync(config, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[] }> }).mcpServers?.["de-web-sdk"];
  } catch {
    return undefined;
  }
  if (!entry?.command) return undefined;
  const client = new Client({ name: "de-web-sdk-reference-harness", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: entry.command === "node" ? process.execPath : entry.command,
      args: entry.args ?? [],
      cwd: worktree,
      env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", DE_WEB_SDK_OFFLINE: "1" },
      stderr: "ignore",
    }),
  );
  const listed = await client.listTools();
  const tools: ToolSpec[] = listed.tools
    .filter((t) => t.name !== "submit_feedback")
    .map((t) => ({ type: "function", function: { name: `${SDK_PREFIX}${t.name}`, description: t.description ?? t.name, parameters: t.inputSchema as Record<string, unknown> } }));
  return { client, tools, instructions: client.getInstructions() };
}

/**
 * Changes whenever the harness's prompt changes, so earlier results aren't reused.
 * Revision 2 stopped listing allowed commands, which named the SDK's commands in every condition.
 */
export const HARNESS_PROMPT_REVISION = 2;

export function systemPrompt(ctx: ReturnType<typeof loadCopilotContext>, sdk?: SdkServer): string {
  const parts = [
    "You are a coding agent working in a git repository. Use the tools to read and change files and to run commands, then call finish.",
    "Commands this trial doesn't allow are refused, and the refusal names the allowed ones.",
  ];
  if (sdk?.instructions) parts.push(`Instructions from the de-web-sdk MCP server, whose tools start with ${SDK_PREFIX}:\n${sdk.instructions}`);
  if (ctx.always.length) parts.push("Repository instructions:", ...ctx.always);
  if (ctx.skills.length) {
    parts.push("Skills you can load with read_file when they apply:", ...ctx.skills.map((s) => `- ${s.name}: ${s.description} (${s.file})`));
  }
  return parts.join("\n\n");
}

/**
 * A small tool-using agent loop, the reference harness. It stays inside the
 * worktree, refuses commands that aren't allowed, and attaches path-scoped
 * instructions when it touches a matching file, as Copilot does.
 */
export async function runHarness(trial: TrialContext, client: ModelClient, maxSteps = 40): Promise<TrialOutcome> {
  const context = loadCopilotContext(trial.worktree);
  let sdk: SdkServer | undefined;
  try {
    sdk = await startSdkServer(trial.worktree, trial.env);
  } catch {
    sdk = undefined;
  }
  const tools = [...TOOLS, ...(sdk?.tools ?? [])];
  const sdkUse: Record<string, number> = {};
  const count = (key: string | undefined) => {
    if (key) sdkUse[key] = (sdkUse[key] ?? 0) + 1;
  };
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(context, sdk) },
    { role: "user", content: trial.prompt },
  ];
  const attached = new Set<string>();
  const deadline = Date.now() + trial.timeoutMs;
  let acted = false;
  let reportedModel: string | undefined;
  const transcript = () => writeFileSync(path.join(trial.cacheDir, "transcript.json"), `${JSON.stringify(messages, null, 2)}\n`);

  const scopedFor = (rel: string): string => {
    const extra: string[] = [];
    for (const s of context.scoped) {
      if (!attached.has(s.file) && s.match(rel)) {
        attached.add(s.file);
        extra.push(`\n\n[Instructions from ${s.file}]\n${s.body}`);
      }
    }
    return extra.join("");
  };

  const tool = async (call: ToolCall): Promise<string> => {
    let args: Record<string, string>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return "error: the arguments aren't valid JSON";
    }
    if (sdk && call.function.name.startsWith(SDK_PREFIX)) {
      const name = call.function.name.slice(SDK_PREFIX.length);
      count(`mcp:${name}`);
      try {
        const result = await sdk.client.callTool({ name, arguments: args });
        const out = ((result.content as Array<{ type: string; text?: string }>) ?? []).map((c) => c.text ?? "").join("\n");
        return result.isError ? `error: ${out}` : out;
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    }
    const inside = (p: string) => resolveInside(trial.worktree, p ?? ".");
    switch (call.function.name) {
      case "list_files": {
        const abs = inside(args.path!);
        if (!abs) return "error: the path is outside the repository";
        return walkFiles(abs, { skipDirs: ["node_modules", ".git"] }).slice(0, 500).join("\n") || "(no files)";
      }
      case "read_file": {
        const abs = inside(args.path!);
        if (!abs || !existsSync(abs)) return "error: no such file in the repository";
        const text = readFileSync(abs, "utf8");
        return (text.length > 60_000 ? `${text.slice(0, 60_000)}\n[truncated]` : text) + scopedFor(path.relative(trial.worktree, abs).split(path.sep).join("/"));
      }
      case "write_file": {
        const abs = inside(args.path!);
        if (!abs || abs.includes(`${path.sep}node_modules${path.sep}`) || abs.includes(`${path.sep}.git${path.sep}`)) return "error: the path is outside the files you can change";
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, args.content ?? "");
        return `wrote ${args.path}` + scopedFor(path.relative(trial.worktree, abs).split(path.sep).join("/"));
      }
      case "run_command": {
        const command = args.command ?? "";
        count(/\bde-web-sdk\s+(resolve|check|skill|feedback|sync)\b/.exec(command)?.[1] ? `cli:${/\bde-web-sdk\s+(resolve|check|skill|feedback|sync)\b/.exec(command)![1]}` : undefined);
        if (!commandAllowed(command, trial.allowedCommands)) return `error: the command isn't allowed in this trial. Allowed: ${trial.allowedCommands.join(", ")}`;
        try {
          const out = execSync(command, {
            cwd: trial.worktree,
            env: { ...trial.env, PATH: `${path.join(trial.worktree, "node_modules", ".bin")}${path.delimiter}${trial.env.PATH ?? ""}` },
            encoding: "utf8",
            timeout: Math.max(1000, Math.min(180_000, deadline - Date.now())),
            stdio: ["ignore", "pipe", "pipe"],
          });
          return `exit 0\n${out.slice(-8000)}`;
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return `exit ${err.status ?? 1}\n${`${err.stdout ?? ""}${err.stderr ?? ""}`.slice(-8000)}`;
        }
      }
      default:
        return `error: unknown tool ${call.function.name}`;
    }
  };

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() > deadline) {
        transcript();
        await sdk?.client.close().catch(() => undefined);
        return { status: "timeout", acted, reportedModel, sdkUse, error: "the agent ran past its time budget" };
      }
      await trial.pacer.wait();
      let reply;
      try {
        reply = await client.chat(messages, tools);
      } catch (e) {
        transcript();
        await sdk?.client.close().catch(() => undefined);
        return { status: "error", acted, reportedModel, sdkUse, error: (e as Error).message };
      }
      acted = true;
      reportedModel ??= reply.model;
      messages.push(reply.message);
      const calls = reply.message.tool_calls ?? [];
      if (!calls.length) break;
      let finished = false;
      for (const call of calls) {
        if (call.function.name === "finish") finished = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: call.function.name === "finish" ? "ok" : await tool(call) });
      }
      if (finished) break;
    }
    transcript();
    await sdk?.client.close().catch(() => undefined);
    return { status: "completed", acted, reportedModel, sdkUse };
  } catch (e) {
    transcript();
    await sdk?.client.close().catch(() => undefined);
    return { status: "error", acted, reportedModel, sdkUse, error: (e as Error).message };
  }
}
