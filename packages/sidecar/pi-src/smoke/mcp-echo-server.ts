// Dependency-free stdio MCP server for the sidecar smoke test: one `echo` tool.
// Newline-delimited JSON-RPC, matching the MCP stdio transport.

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(msg: { id?: number | string; method?: string; params?: any }) {
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "1" },
          instructions: "Echo test server",
        },
      });
    case "tools/list":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo text back",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        },
      });
    case "tools/call":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text}` }] },
      });
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
