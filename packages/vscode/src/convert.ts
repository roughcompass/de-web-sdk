/**
 * Converts between the reference harness's OpenAI-style chat messages and
 * VS Code's language model messages. It takes the VS Code classes as
 * parameters, so tests run without VS Code.
 */

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

export interface VsCodeLm<Msg, Text, Call, Result> {
  user(content: string | Array<Text | Result>): Msg;
  assistant(content: string | Array<Text | Call>): Msg;
  text(value: string): Text;
  toolCall(callId: string, name: string, input: object): Call;
  toolResult(callId: string, content: Text[]): Result;
}

/**
 * VS Code's language model API has no system role, so the system prompt
 * becomes the first user message. Tool results follow as user messages, as
 * the API requires.
 */
export function toVsCodeMessages<Msg, Text, Call, Result>(messages: ChatMessage[], lm: VsCodeLm<Msg, Text, Call, Result>): Msg[] {
  const out: Msg[] = [];
  let pendingResults: Result[] = [];
  const flush = () => {
    if (pendingResults.length) {
      out.push(lm.user(pendingResults));
      pendingResults = [];
    }
  };
  for (const m of messages) {
    if (m.role === "tool") {
      pendingResults.push(lm.toolResult(m.tool_call_id ?? "", [lm.text(m.content ?? "")]));
      continue;
    }
    flush();
    if (m.role === "system") out.push(lm.user(`Instructions:\n${m.content ?? ""}`));
    else if (m.role === "user") out.push(lm.user(m.content ?? ""));
    else {
      const parts: Array<Text | Call> = [];
      if (m.content) parts.push(lm.text(m.content));
      for (const call of m.tool_calls ?? []) {
        let input: object = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        parts.push(lm.toolCall(call.id, call.function.name, input));
      }
      out.push(lm.assistant(parts.length ? parts : ""));
    }
  }
  flush();
  return out;
}

export function toVsCodeTools(tools: ToolSpec[]): Array<{ name: string; description: string; inputSchema: object }> {
  return tools.map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));
}

export type ResponsePart = { kind: "text"; value: string } | { kind: "toolCall"; callId: string; name: string; input: object };

/** Collects a streamed response into one assistant message. */
export function toChatMessage(parts: ResponsePart[]): ChatMessage {
  const text = parts.filter((p): p is Extract<ResponsePart, { kind: "text" }> => p.kind === "text").map((p) => p.value).join("");
  const calls = parts
    .filter((p): p is Extract<ResponsePart, { kind: "toolCall" }> => p.kind === "toolCall")
    .map((p): ToolCall => ({ id: p.callId, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }));
  return { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export const BRIDGE_PROTOCOL = 1;

/**
 * Finds the language model tool that VS Code lists for an MCP server's tool.
 * VS Code names them like `mcp_<server>_<tool>`, so punctuation is compared
 * loosely. An exact name also matches.
 */
export function matchTool(names: string[], server: string, tool: string): string | undefined {
  if (names.includes(tool)) return tool;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const t = norm(tool);
  const srv = norm(server);
  return names.find((n) => {
    const name = norm(n);
    return name.endsWith(`_${t}`) && name.includes(srv);
  });
}
