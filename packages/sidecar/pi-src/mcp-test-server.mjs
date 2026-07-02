// Test fixture (HOY-232): a minimal real MCP server over stdio, used by
// hoy-mcp.test.ts to exercise the client round-trip against real SDK code.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "hoy-mcp-test", version: "0.0.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo back the provided text.",
    inputSchema: { text: z.string().describe("Text to echo back") },
  },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
  "add",
  {
    title: "Add",
    description: "Add two numbers.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

await server.connect(new StdioServerTransport());
