import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpFeedbackTarget, McpToolCaller } from "@de-web-sdk/core";

/** An MCP server that the developer configured for VS Code or Claude Code. */
export interface ConfiguredServer {
  name: string;
  /** Which file defined it, for messages. */
  source: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface RawServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** VS Code's user settings folder on each platform. */
function vscodeUserDir(home: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Code", "User");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Code", "User");
}

/**
 * The MCP servers available to the developer's agents, in the order the SDK
 * searches them: the repo's `.mcp.json` and `.vscode/mcp.json`, Claude Code's
 * user and project settings in `~/.claude.json`, and VS Code's user `mcp.json`.
 */
export function configuredServers(root: string, env: NodeJS.ProcessEnv = process.env, home: string = env.DE_WEB_SDK_HOME ?? os.homedir()): ConfiguredServer[] {
  const out: ConfiguredServer[] = [];
  const add = (source: string, servers: unknown) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, RawServer>)) {
      if (!raw || typeof raw !== "object") continue;
      const type = raw.url || raw.type === "http" || raw.type === "sse" ? "http" : "stdio";
      out.push({ name, source, type, command: raw.command, args: raw.args, env: raw.env, cwd: raw.cwd, url: raw.url, headers: raw.headers });
    }
  };
  add(".mcp.json", readJson(path.join(root, ".mcp.json"))?.mcpServers);
  add(".vscode/mcp.json", readJson(path.join(root, ".vscode", "mcp.json"))?.servers);
  const claude = readJson(path.join(home, ".claude.json"));
  add("~/.claude.json", claude?.mcpServers);
  const projects = claude?.projects as Record<string, { mcpServers?: unknown }> | undefined;
  add("~/.claude.json (this project)", projects?.[root]?.mcpServers);
  add("VS Code user mcp.json", readJson(path.join(vscodeUserDir(home, env), "mcp.json"))?.servers);
  return out;
}

/** Finds the pack's named server, or one at the pack's URL. */
export function locateServer(target: McpFeedbackTarget, servers: ConfiguredServer[]): ConfiguredServer | undefined {
  return servers.find((s) => s.name === target.server) ?? (target.url ? servers.find((s) => s.url === target.url) : undefined);
}

type Expanded<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Expands `${VAR}`, `${VAR:-default}`, `${env:VAR}`, and `${workspaceFolder}`.
 * Other VS Code variables, such as `${input:…}` prompts, can't be answered here.
 */
export function expand(value: string, env: NodeJS.ProcessEnv, root: string): Expanded<string> {
  let missing: string | undefined;
  const out = value.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    if (expr === "workspaceFolder") return root;
    let name = expr;
    let fallback: string | undefined;
    if (expr.startsWith("env:")) name = expr.slice(4);
    else if (expr.includes(":-")) {
      name = expr.slice(0, expr.indexOf(":-"));
      fallback = expr.slice(expr.indexOf(":-") + 2);
    } else if (expr.includes(":")) {
      missing ??= expr;
      return "";
    }
    const v = env[name] ?? fallback;
    if (v === undefined) missing ??= name;
    return v ?? "";
  });
  return missing ? { ok: false, reason: `it needs \${${missing}}, which isn't available outside the tool that defines the server` } : { ok: true, value: out };
}

function expandAll(record: Record<string, string> | undefined, env: NodeJS.ProcessEnv, root: string): Expanded<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record ?? {})) {
    const r = expand(v, env, root);
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return { ok: true, value: out };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
}

export interface CallOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
  /** Tries the VS Code extension's bridge, for servers whose sign-in only VS Code holds. */
  viaVsCode?: (target: McpFeedbackTarget, args: Record<string, string | number | boolean>) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
}

/**
 * Returns a tool caller for feedback adapters. It connects to the developer's
 * configured server as an MCP client, calls the tool, and returns its text.
 */
export function mcpToolCaller(options: CallOptions): McpToolCaller {
  const env = options.env ?? process.env;
  return async (target, args) => {
    const server = locateServer(target, configuredServers(options.root, env, options.home));
    if (!server) {
      if (options.viaVsCode) {
        const viaCode = await options.viaVsCode(target, args);
        if (viaCode.ok) return viaCode;
      }
      return { ok: false, reason: `no MCP server named ${JSON.stringify(target.server)} is configured for VS Code or Claude Code on this machine` };
    }
    let transport;
    if (server.type === "stdio") {
      if (!server.command) return { ok: false, reason: `the server ${server.name} in ${server.source} has no command` };
      const cmd = expand(server.command, env, options.root);
      const argv = (server.args ?? []).map((a) => expand(a, env, options.root));
      const childEnv = expandAll(server.env, env, options.root);
      const bad = [cmd, ...argv, childEnv].find((r) => !r.ok) as { ok: false; reason: string } | undefined;
      if (bad) return { ok: false, reason: `the server ${server.name} in ${server.source} can't start here: ${bad.reason}` };
      transport = new StdioClientTransport({
        command: (cmd as { value: string }).value,
        args: argv.map((a) => (a as { value: string }).value),
        env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", ...(childEnv as { value: Record<string, string> }).value },
        cwd: server.cwd ? path.resolve(options.root, server.cwd) : options.root,
        stderr: "ignore",
      });
    } else {
      const url = expand(server.url ?? "", env, options.root);
      const headers = expandAll(server.headers, env, options.root);
      if (!url.ok || !headers.ok) {
        if (options.viaVsCode) {
          const viaCode = await options.viaVsCode(target, args);
          if (viaCode.ok) return viaCode;
        }
        return { ok: false, reason: `the server ${server.name} in ${server.source} can't be reached here: ${(!url.ok ? url : (headers as { ok: false; reason: string })).reason}` };
      }
      transport = new StreamableHTTPClientTransport(new URL(url.value), { requestInit: { headers: headers.value } });
    }
    const client = new Client({ name: "de-web-sdk-feedback", version: "1" });
    const timeout = options.timeoutMs ?? 30_000;
    try {
      await client.connect(transport, { timeout });
      const result = await client.callTool({ name: target.tool, arguments: args }, undefined, { timeout });
      if ((result as { isError?: boolean }).isError) return { ok: false, reason: `the tool ${target.tool} reported an error: ${textOf(result).slice(0, 300)}` };
      return { ok: true, text: textOf(result) };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (server.type === "http" && /401|403|unauthori[sz]ed|oauth/i.test(message) && options.viaVsCode) {
        const viaCode = await options.viaVsCode(target, args);
        if (viaCode.ok) return viaCode;
      }
      return { ok: false, reason: `the MCP server ${server.name} (${server.source}) failed: ${message.slice(0, 300)}` };
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

/**
 * Calls a tool through the SDK's VS Code extension, which invokes it with
 * VS Code's own sign-in. VS Code lists an MCP server's tools only once that
 * server has started.
 */
export function vscodeToolCaller(env: NodeJS.ProcessEnv = process.env, home: string = env.DE_WEB_SDK_HOME ?? os.homedir()): NonNullable<CallOptions["viaVsCode"]> {
  return async (target, args) => {
    const file = env.DE_WEB_SDK_VSCODE_BRIDGE ?? path.join(home, ".de-web-sdk", "vscode-bridge.json");
    const bridge = readJson(file) as { port?: number; token?: string } | undefined;
    if (!bridge?.port || !bridge.token) return { ok: false, reason: "the VS Code extension's bridge isn't running" };
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/tools/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ server: target.server, tool: target.tool, input: args }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
      return response.ok && typeof body.text === "string" ? { ok: true, text: body.text } : { ok: false, reason: body.error ?? `the VS Code bridge answered ${response.status}` };
    } catch (e) {
      return { ok: false, reason: `the VS Code bridge isn't reachable (${(e as Error).message})` };
    }
  };
}
