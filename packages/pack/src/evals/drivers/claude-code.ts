import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Route } from "../profile.ts";
import type { Driver, TrialContext, TrialOutcome } from "./types.ts";

/** Names the SDK command in a shell command, such as `cli:check`. */
export function cliUse(command: string | undefined): string | undefined {
  const m = /\bde-web-sdk\s+(resolve|check|skill|feedback|sync)\b/.exec(command ?? "");
  return m ? `cli:${m[1]}` : undefined;
}

function claudeBinary(env: NodeJS.ProcessEnv): string {
  return env.DE_WEB_SDK_CLAUDE_BIN ?? "claude";
}

/** The SDK's MCP tools a trial may call. Trials never send feedback. */
export const SDK_MCP_TOOLS = ["resolve", "check", "get_skill", "read_pack_file", "draft_feedback"].map((t) => `mcp__de-web-sdk__${t}`);

/** Converts allowed commands into Claude Code permission rules. */
export function allowedTools(allowed: string[], mcp = false): string[] {
  const tools = ["Read", "Edit", "Write", "Glob", "Grep", ...(mcp ? SDK_MCP_TOOLS : [])];
  for (const a of allowed) {
    const norm = a.trim().replace(/\s+/g, " ");
    tools.push(norm.endsWith(" *") ? `Bash(${norm.slice(0, -2)}:*)` : `Bash(${norm})`);
  }
  return tools;
}

/**
 * Runs each trial as a fresh headless Claude Code session. On a laptop it
 * uses the developer's own sign-in; in the pipeline it uses the route's
 * endpoint. `dontAsk` denies every tool the allow list doesn't name, so the
 * agent can't run other commands, and the trial continues.
 */
export const claudeCodeDriver: Driver = {
  name: "claude-code",

  async available(route: Route, env) {
    if (route.endpoint) {
      const name = route.credentialEnv ?? "ANTHROPIC_AUTH_TOKEN";
      if (!env[name]) return { ok: false, reason: `the endpoint's credential ${name} isn't set` };
    }
    const probe = spawnSync(claudeBinary(env), ["--version"], { encoding: "utf8", env });
    if (probe.status !== 0) return { ok: false, reason: "Claude Code isn't installed on this machine" };
    return { ok: true };
  },

  async version(_route, env) {
    const probe = spawnSync(claudeBinary(env), ["--version"], { encoding: "utf8", env });
    return (probe.stdout ?? "").trim().split(/\s+/)[0] ?? "unknown";
  },

  run(trial: TrialContext): Promise<TrialOutcome> {
    const env: NodeJS.ProcessEnv = { ...trial.env, PATH: `${path.join(trial.worktree, "node_modules", ".bin")}${path.delimiter}${trial.env.PATH ?? ""}` };
    if (trial.route.endpoint) {
      env.ANTHROPIC_BASE_URL = trial.route.endpoint;
      env.ANTHROPIC_AUTH_TOKEN = trial.env[trial.route.credentialEnv ?? "ANTHROPIC_AUTH_TOKEN"];
    }
    const mcpConfig = existsSync(path.join(trial.worktree, ".mcp.json")) ? path.join(trial.worktree, ".mcp.json") : undefined;
    env.MCP_TOOL_TIMEOUT = String(trial.timeoutMs);
    const args = [
      "-p",
      trial.prompt,
      "--model",
      trial.modelId,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "project,local",
      // Only the trial's own .mcp.json loads, so the developer's personal servers stay out of trials.
      ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
      "--strict-mcp-config",
      "--allowedTools",
      ...allowedTools(trial.allowedCommands, Boolean(mcpConfig)),
    ];
    return new Promise((resolve) => {
      const child = spawn(claudeBinary(env), args, { cwd: trial.worktree, env, stdio: ["ignore", "pipe", "pipe"] });
      const lines: string[] = [];
      let buffer = "";
      let stderr = "";
      let acted = false;
      let reportedModel: string | undefined;
      let timedOut = false;
      const sdkUse: Record<string, number> = {};
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, trial.timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        buffer += d.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          lines.push(line);
          try {
            const msg = JSON.parse(line) as { type?: string; subtype?: string; model?: string; message?: { model?: string; content?: Array<{ type?: string; name?: string; input?: { command?: string } }> } };
            if (msg.type === "system" && msg.subtype === "init" && msg.model) reportedModel = msg.model;
            if (msg.type === "assistant") {
              acted = true;
              reportedModel ??= msg.message?.model;
              for (const part of msg.message?.content ?? []) {
                if (part.type !== "tool_use" || !part.name) continue;
                const key = part.name.startsWith("mcp__de-web-sdk__") ? `mcp:${part.name.slice("mcp__de-web-sdk__".length)}` : part.name === "Bash" ? cliUse(part.input?.command) : undefined;
                if (key) sdkUse[key] = (sdkUse[key] ?? 0) + 1;
              }
            }
          } catch {
            // Non-JSON lines stay in the transcript.
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 32 * 1024) stderr += d.toString("utf8");
      });
      const finish = (outcome: TrialOutcome) => {
        clearTimeout(timer);
        writeFileSync(path.join(trial.cacheDir, "transcript.jsonl"), `${lines.join("\n")}\n`);
        if (stderr) writeFileSync(path.join(trial.cacheDir, "stderr.txt"), stderr);
        resolve(outcome);
      };
      child.on("error", (e) => finish({ status: "error", acted: false, error: e.message }));
      child.on("close", (code) => {
        if (timedOut) return finish({ status: "timeout", acted, reportedModel, sdkUse, error: `the agent ran past its time budget of ${Math.round(trial.timeoutMs / 1000)} seconds` });
        if (code === 0 || acted) return finish({ status: "completed", acted, reportedModel, sdkUse });
        finish({ status: "error", acted, reportedModel, sdkUse, error: stderr.trim().split("\n").slice(-2).join(" ") || `claude exited with ${code}` });
      });
    });
  },
};
