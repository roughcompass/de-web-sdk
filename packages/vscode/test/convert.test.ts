import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchTool, toChatMessage, toVsCodeMessages, toVsCodeTools, type ChatMessage } from "../src/convert.ts";

// Plain stand-ins for VS Code's classes.
const lm = {
  user: (content: unknown) => ({ role: "user", content }),
  assistant: (content: unknown) => ({ role: "assistant", content }),
  text: (value: string) => ({ text: value }),
  toolCall: (callId: string, name: string, input: object) => ({ callId, name, input }),
  toolResult: (callId: string, content: unknown[]) => ({ result: callId, content }),
};

describe("VS Code language model conversion", () => {
  it("turns the system prompt into the first user message and groups tool results", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Follow AGENTS.md." },
      { role: "user", content: "Do the task." },
      { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
      ] },
      { role: "tool", tool_call_id: "c1", content: "A" },
      { role: "tool", tool_call_id: "c2", content: "B" },
    ];
    const out = toVsCodeMessages(messages, lm);
    assert.deepEqual(out, [
      { role: "user", content: "Instructions:\nFollow AGENTS.md." },
      { role: "user", content: "Do the task." },
      { role: "assistant", content: [{ callId: "c1", name: "read_file", input: { path: "a.ts" } }, { callId: "c2", name: "read_file", input: { path: "b.ts" } }] },
      { role: "user", content: [{ result: "c1", content: [{ text: "A" }] }, { result: "c2", content: [{ text: "B" }] }] },
    ]);
  });

  it("collects streamed parts into one assistant message with tool calls", () => {
    const msg = toChatMessage([
      { kind: "text", value: "Reading " },
      { kind: "text", value: "files." },
      { kind: "toolCall", callId: "x", name: "run_command", input: { command: "npx de-web-sdk check" } },
    ]);
    assert.deepEqual(msg, {
      role: "assistant",
      content: "Reading files.",
      tool_calls: [{ id: "x", type: "function", function: { name: "run_command", arguments: '{"command":"npx de-web-sdk check"}' } }],
    });
  });

  it("passes tool schemas through", () => {
    assert.deepEqual(toVsCodeTools([{ type: "function", function: { name: "finish", description: "Done", parameters: { type: "object" } } }]), [{ name: "finish", description: "Done", inputSchema: { type: "object" } }]);
  });

  it("finds an MCP server's tool among the names VS Code lists", () => {
    const names = ["copilot_readFile", "mcp_de-web-sdk_resolve", "mcp_de-web-sdk_check", "mcp_atlassian_createJiraIssue"];
    assert.equal(matchTool(names, "de-web-sdk", "resolve"), "mcp_de-web-sdk_resolve");
    assert.equal(matchTool(names, "atlassian", "createJiraIssue"), "mcp_atlassian_createJiraIssue");
    assert.equal(matchTool(names, "other", "resolve"), undefined);
    assert.equal(matchTool(names, "x", "mcp_de-web-sdk_check"), "mcp_de-web-sdk_check");
  });
});
