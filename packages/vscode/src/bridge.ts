import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { BRIDGE_PROTOCOL, matchTool, toChatMessage, toVsCodeMessages, toVsCodeTools, type ChatMessage, type ResponsePart, type ToolSpec } from "./convert.ts";

export function bridgeFile(): string {
  return process.env.DE_WEB_SDK_VSCODE_BRIDGE ?? path.join(os.homedir(), ".de-web-sdk", "vscode-bridge.json");
}

let notify: (message: string) => void = () => undefined;

export function setNotifier(fn: (message: string) => void): void {
  notify = fn;
}

const lm = {
  user: (content: string | Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart>) => vscode.LanguageModelChatMessage.User(content),
  assistant: (content: string | Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>) => vscode.LanguageModelChatMessage.Assistant(content),
  text: (value: string) => new vscode.LanguageModelTextPart(value),
  toolCall: (callId: string, name: string, input: object) => new vscode.LanguageModelToolCallPart(callId, name, input),
  toolResult: (callId: string, content: vscode.LanguageModelTextPart[]) => new vscode.LanguageModelToolResultPart(callId, content),
};

async function body(req: IncomingMessage): Promise<unknown> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 8 * 1024 * 1024) throw new Error("request too large");
  }
  return JSON.parse(data || "{}");
}

/**
 * A local HTTP bridge from the producer toolkit's reference harness to
 * VS Code's language model API. It listens on 127.0.0.1 only, requires a
 * random token, and writes its address to a file only the user can read.
 * VS Code asks the developer to consent before the first request.
 */
export class EvalBridge {
  private server: Server | undefined;
  private readonly token = randomBytes(24).toString("hex");
  private readonly version: string;
  private readonly log: vscode.OutputChannel;

  constructor(version: string, log: vscode.OutputChannel) {
    this.version = version;
    this.log = log;
  }

  get running(): boolean {
    return Boolean(this.server);
  }

  async start(): Promise<number> {
    if (this.server) {
      // Another window may have removed the address file, so write it again.
      const port = (this.server.address() as { port: number }).port;
      this.publish(port);
      return port;
    }
    const server = createServer(async (req, res) => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: "unauthorized" });
      try {
        if (req.method === "GET" && req.url === "/v1/info") {
          const models = await vscode.lm.selectChatModels({});
          return send(200, { version: this.version, protocol: BRIDGE_PROTOCOL, models: models.map((m) => ({ vendor: m.vendor, family: m.family, id: m.id, name: m.name })) });
        }
        if (req.method === "POST" && req.url === "/v1/chat") {
          const request = (await body(req)) as { vendor?: string; family?: string; id?: string; messages: ChatMessage[]; tools: ToolSpec[] };
          const [model] = await vscode.lm.selectChatModels({ vendor: request.vendor ?? "copilot", ...(request.family ? { family: request.family } : {}), ...(request.id ? { id: request.id } : {}) });
          notify(`Chat request: vendor ${request.vendor ?? "copilot"}, family ${request.family ?? "any"}, ${request.messages.length} messages, model ${model ? `${model.vendor}/${model.family}/${model.id}` : "none"}.`);
          if (!model) return send(404, { error: `No language model matches vendor ${request.vendor ?? "copilot"}${request.family ? `, family ${request.family}` : ""}. Your Copilot plan or the enterprise's policy may hide it` });
          const cancel = new vscode.CancellationTokenSource();
          const timer = setTimeout(() => cancel.cancel(), 280_000);
          try {
            const response = await model.sendRequest(
              toVsCodeMessages(request.messages, lm),
              { justification: "Runs the pack eval trials you started with de-web-sdk-pack.", tools: toVsCodeTools(request.tools), toolMode: vscode.LanguageModelChatToolMode.Auto },
              cancel.token,
            );
            const parts: ResponsePart[] = [];
            for await (const part of response.stream) {
              if (part instanceof vscode.LanguageModelTextPart) parts.push({ kind: "text", value: part.value });
              else if (part instanceof vscode.LanguageModelToolCallPart) parts.push({ kind: "toolCall", callId: part.callId, name: part.name, input: part.input });
            }
            return send(200, { message: toChatMessage(parts), model: `${model.vendor}/${model.family}/${model.id}` });
          } finally {
            clearTimeout(timer);
            cancel.dispose();
          }
        }
        if (req.method === "GET" && req.url === "/v1/tools") {
          return send(200, { tools: vscode.lm.tools.map((t) => ({ name: t.name, description: t.description, tags: t.tags })) });
        }
        if (req.method === "POST" && req.url === "/v1/tools/invoke") {
          // Feedback adapters call a named MCP server's tool with VS Code's own sign-in.
          const request = (await body(req)) as { server?: string; tool?: string; input?: object };
          const tool = String(request.tool ?? "");
          const name = matchTool(vscode.lm.tools.map((t) => t.name), String(request.server ?? ""), tool);
          if (!name) return send(404, { error: `VS Code doesn't list a tool ${tool} from the MCP server ${request.server}. Start that server in VS Code first` });
          notify(`Invoking ${name} for a feedback report.`);
          const result = await vscode.lm.invokeTool(name, { input: request.input ?? {}, toolInvocationToken: undefined });
          const textOut = result.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "")).join("\n");
          return send(200, { tool: name, text: textOut });
        }
        return send(404, { error: "not found" });
      } catch (e) {
        const message = e instanceof vscode.LanguageModelError ? `${e.code}: ${e.message}` : (e as Error).message;
        notify(`Bridge request failed: ${message}`);
        return send(502, { error: message });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    this.server = server;
    const port = (server.address() as { port: number }).port;
    this.publish(port);
    notify(`Eval bridge listening on 127.0.0.1:${port}.`);
    return port;
  }

  private publish(port: number): void {
    const file = bridgeFile();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ port, token: this.token, version: this.version, protocol: BRIDGE_PROTOCOL, pid: process.pid }), { mode: 0o600 });
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = undefined;
    // Each VS Code window runs its own extension host, so remove the address file only if it names this bridge.
    try {
      if ((JSON.parse(readFileSync(bridgeFile(), "utf8")) as { token?: string }).token === this.token) rmSync(bridgeFile(), { force: true });
    } catch {
      // No file, or one this bridge didn't write.
    }
  }
}
