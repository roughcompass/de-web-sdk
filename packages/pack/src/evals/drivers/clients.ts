import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SdkError } from "@de-web-sdk/core";
import type { ChatMessage, ModelClient, ToolSpec } from "./harness.ts";

/** An OpenAI-compatible chat completions endpoint, such as an enterprise gateway. */
export function openAiClient(endpoint: string, model: string, token: string | undefined): ModelClient {
  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  return {
    async chat(messages: ChatMessage[], tools: ToolSpec[]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`the endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as { model?: string; choices?: Array<{ message?: ChatMessage }> };
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("the endpoint returned no message");
      return { message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) }, model: body.model };
    },
  };
}

export interface BridgeInfo {
  port: number;
  token: string;
  version: string;
  protocol: number;
}

export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_START_URI = "vscode://de-web-sdk.de-web-sdk-vscode/start-bridge";

export function bridgeFile(env: NodeJS.ProcessEnv): string {
  return env.DE_WEB_SDK_VSCODE_BRIDGE ?? path.join(os.homedir(), ".de-web-sdk", "vscode-bridge.json");
}

export function readBridge(env: NodeJS.ProcessEnv): BridgeInfo | undefined {
  const file = bridgeFile(env);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BridgeInfo;
  } catch {
    return undefined;
  }
}

export function vsixName(version: string): string {
  return `de-web-sdk-vscode-${version}.vsix`;
}

/**
 * Checks that the running extension matches this toolkit. VSIX installs don't
 * update themselves, so a mismatch names the VSIX to install.
 */
export async function checkBridge(env: NodeJS.ProcessEnv, expectedVersion: string): Promise<{ ok: true; info: BridgeInfo; models: Array<{ vendor: string; family: string; id: string }> } | { ok: false; reason: string }> {
  const info = readBridge(env);
  if (!info) {
    return {
      ok: false,
      reason: `the de-web-sdk VS Code extension's eval bridge isn't running. Start it with \`code --open-url ${BRIDGE_START_URI}\`, or run "de-web-sdk: Start the eval bridge for Copilot models" in VS Code`,
    };
  }
  let remote: { version?: string; protocol?: number; models?: Array<{ vendor: string; family: string; id: string }> };
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/info`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, reason: `the eval bridge answered ${response.status}` };
    remote = (await response.json()) as typeof remote;
  } catch (e) {
    return { ok: false, reason: `the eval bridge isn't reachable (${(e as Error).message}). Restart it from VS Code` };
  }
  if (remote.version !== expectedVersion || remote.protocol !== BRIDGE_PROTOCOL) {
    return {
      ok: false,
      reason: `the VS Code extension is version ${remote.version ?? "unknown"}, but this toolkit needs ${expectedVersion}. Install ${vsixName(expectedVersion)} from Artifactory with \`code --install-extension ${vsixName(expectedVersion)}\``,
    };
  }
  return { ok: true, info, models: remote.models ?? [] };
}

/** Copilot's models through the extension's local bridge to VS Code's language model API. */
export function bridgeClient(info: BridgeInfo, selector: { vendor?: string; family?: string; id?: string }): ModelClient {
  return {
    async chat(messages, tools) {
      const response = await fetch(`http://127.0.0.1:${info.port}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ ...selector, messages, tools }),
        signal: AbortSignal.timeout(300_000),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: ChatMessage; model?: string; error?: string };
      if (!response.ok || !body.message) throw new SdkError("usage", body.error ?? `the eval bridge answered ${response.status}`);
      return { message: body.message, model: body.model };
    },
  };
}
