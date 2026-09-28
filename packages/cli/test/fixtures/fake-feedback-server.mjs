// A stand-in for a Jira or feature request MCP server. It records each call
// to the file named in FAKE_LOG and answers like an issue tracker would.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-tracker", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "createJiraIssue", description: "Create an issue", inputSchema: { type: "object", properties: { projectKey: { type: "string" }, summary: { type: "string" }, description: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: request.params.name, arguments: request.params.arguments })}\n`);
  if (request.params.name !== "createJiraIssue") return { content: [{ type: "text", text: "unknown tool" }], isError: true };
  return { content: [{ type: "text", text: "Created WEBRT-123: https://jira.example.com/browse/WEBRT-123" }] };
});
await server.connect(new StdioServerTransport());
