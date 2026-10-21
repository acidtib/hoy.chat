// Smoke test for the COMPILED sidecar binary (bun --compile output), not the
// sources. The bugs that only exist in the compiled binary are what this
// catches: OAuth flow loaders (registerBunOAuthFlows), the payload's branded
// piConfig, Pi's MCP + tool_search wiring, codemode's sandbox worker and QuickJS
// wasm, and a stale binary (HOY-200).
//
// It drives the binary the way Rust does (RPC JSONL over stdio, split on \n
// only) against a local mock OpenAI-compatible model that scripts two turns:
// tool_search -> mcp__echo__echo (approved through the permission gate) -> text,
// then with codemode on, one codemode script calling mcp__echo__echo -> text.
//
// Usage: bun packages/sidecar/pi-src/smoke/smoke-test.ts <path-to-hoy-pi-binary>
// PI_PACKAGE_DIR defaults to packages/sidecar/pi-payload.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const binaryArg = process.argv[2];
if (!binaryArg) {
  console.error("usage: bun smoke-test.ts <path-to-hoy-pi-binary>");
  process.exit(2);
}
const binary = resolve(binaryArg);
const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const payload = process.env.PI_PACKAGE_DIR ?? resolve(here, "..", "..", "pi-payload");
const TIMEOUT_MS = 90_000;

const root = mkdtempSync(join(tmpdir(), "hoy-smoke-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

// Mock model: answers by how many tool results the request already carries,
// with the first tool call picked by whether codemode is declared.
const requests: Array<{ tools: string[]; mcpSection: boolean }> = [];
let requestsAtTurnStart = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req: Request) {
    const body: any = await req.json();
    const messages: any[] = body.messages ?? [];
    requests.push({
      tools: (body.tools ?? []).map((t: any) => t.function?.name),
      mcpSection: JSON.stringify(messages).includes("MCP servers whose tools"),
    });
    const toolResults = messages.filter((m) => m.role === "tool").length;
    const codemode = requests.at(-1)!.tools.includes("codemode");
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        model: "mock",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const toolCall = (name: string, args: unknown) =>
      chunk(
        {
          role: "assistant",
          tool_calls: [{ index: 0, id: `call_${toolResults}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        null,
      ) + chunk({}, "tool_calls");
    let sse: string;
    if (codemode && toolResults === 0) {
      sse = toolCall("codemode", { code: 'text(await tools.mcp__echo__echo({ text: "script" }));' });
    } else if (codemode) sse = chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop");
    else if (toolResults === 0) sse = toolCall("tool_search", { query: "echo" });
    else if (toolResults === 1) sse = toolCall("mcp__echo__echo", { text: "smoke" });
    else sse = chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop");
    return new Response(`${sse}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  },
});

writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: "openai-completions",
        apiKey: "mock",
        models: [{ id: "mock", reasoning: false }],
      },
    },
  }),
);
function writeMcpConfig(codemode: boolean) {
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      ...(codemode ? { codemode: true } : {}),
      mcpServers: { echo: { command: process.execPath, args: [join(here, "mcp-echo-server.ts")] } },
    }),
  );
}

// Mirror Rust's sanitized spawn env (sidecar.rs apply_sanitized_env): only what
// the OS needs plus Hoy's own variables.
function sidecarEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    PI_TELEMETRY: "0",
    PI_PACKAGE_DIR: payload,
    NODE_PATH: join(payload, "node_modules"),
    HOY_CODING_AGENT_DIR: agentDir,
    ...extra,
  };
}

// Strict JSONL: split on \n only (U+2028/U+2029 are valid inside JSON strings).
async function* jsonLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const checks: string[] = [];
function pass(label: string) {
  checks.push(label);
  console.log(`ok - ${label}`);
}

// One prompt through a fresh sidecar, approving the single MCP call it makes.
async function runTurn(): Promise<{ responses: Map<string, any>; toolEnds: any[]; approvals: number }> {
  requestsAtTurnStart = requests.length;
  const proc = Bun.spawn([binary, "--mode", "rpc"], {
    cwd,
    env: sidecarEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: unknown) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const responses = new Map<string, any>();
  const toolEnds: any[] = [];
  let approvals = 0;
  try {
    send({ id: "state", type: "get_state" });
    send({ id: "queue", type: "clear_queue" });
    send({ id: "model", type: "set_model", provider: "mock", modelId: "mock" });
    send({ id: "prompt", type: "prompt", message: "use the echo tool" });
    for await (const msg of jsonLines(proc.stdout)) {
      if (msg.type === "response") {
        responses.set(msg.id, msg);
        if (!msg.success) throw new Error(`RPC ${msg.command} failed: ${msg.error}`);
      } else if (msg.type === "extension_ui_request" && msg.method === "select") {
        approvals++;
        if (!String(msg.title).includes("mcp__echo__echo")) throw new Error(`unexpected approval: ${msg.title}`);
        send({ type: "extension_ui_response", id: msg.id, value: "Allow" });
      } else if (msg.type === "tool_execution_end") {
        toolEnds.push(msg);
      } else if (msg.type === "agent_settled") {
        break;
      }
    }
  } finally {
    proc.kill();
  }
  return { responses, toolEnds, approvals };
}

async function rpcTurn(): Promise<void> {
  writeMcpConfig(false);
  const { responses, toolEnds, approvals } = await runTurn();
  for (const id of ["state", "queue", "model", "prompt"]) {
    if (!responses.get(id)?.success) throw new Error(`no successful response for ${id}`);
  }
  pass("RPC get_state, clear_queue, set_model, prompt");

  const search = toolEnds.find((e) => e.toolName === "tool_search");
  if (!search || search.isError) throw new Error(`tool_search did not succeed: ${JSON.stringify(search)}`);
  if (!requests[0]?.tools.includes("tool_search")) throw new Error("tool_search not declared to the model");
  if (!requests[0]?.mcpSection) throw new Error("mcp_servers section missing from the prompt");
  pass("Pi MCP: server listed, tool_search declared and loads the tool");

  if (approvals !== 1) throw new Error(`expected 1 approval for the MCP call, got ${approvals}`);
  pass("permission gate asks before the MCP tool call");

  const echo = toolEnds.find((e) => e.toolName === "mcp__echo__echo");
  const text = JSON.stringify(echo?.result?.content ?? "");
  if (!echo || echo.isError || !text.includes("echo: smoke")) {
    throw new Error(`MCP call did not return the echo: ${JSON.stringify(echo)}`);
  }
  pass("MCP tool call round-trips through the stdio server");
}

// Codemode on: the MCP tool is called from a script inside the QuickJS worker,
// and the nested call still passes the permission gate.
async function codemodeTurn(): Promise<void> {
  writeMcpConfig(true);
  const { toolEnds, approvals } = await runTurn();
  const first = requests[requestsAtTurnStart];
  if (!first?.tools.includes("codemode")) throw new Error("codemode not declared with the setting on");
  if (first.tools.includes("mcp__echo__echo")) throw new Error("MCP tool declared directly under codemode");
  if (approvals !== 1) throw new Error(`expected 1 approval for the nested MCP call, got ${approvals}`);
  const script = toolEnds.find((e) => e.toolName === "codemode");
  const text = JSON.stringify(script?.result?.content ?? "");
  if (!script || script.isError || !text.includes("echo: script")) {
    throw new Error(`codemode script did not return the echo: ${JSON.stringify(script)}`);
  }
  pass("codemode script calls the MCP tool through the sandbox and the gate");
}

// The OAuth login mode must reach a provider flow inside the compiled binary.
// Without registerBunOAuthFlows this fails with "Cannot find module" (see
// docs/pi-version-bump.md). Anthropic opens with a local select, no network.
async function oauthStart(): Promise<void> {
  const proc = Bun.spawn([binary], {
    cwd,
    env: sidecarEnv({ HOY_OAUTH_LOGIN: "anthropic" }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for await (const msg of jsonLines(proc.stdout)) {
      if (msg.type === "error") throw new Error(`OAuth flow failed: ${msg.message}`);
      if (["select", "auth_url", "device_code", "prompt"].includes(msg.type)) break;
    }
  } finally {
    proc.kill();
  }
  pass("OAuth login flow loads inside the compiled binary");
}

async function builtinSkills(): Promise<void> {
  writeMcpConfig(false);
  const proc = Bun.spawn([binary, "--mode", "rpc"], {
    cwd,
    env: sidecarEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: unknown) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const responses = new Map<string, any>();
  try {
    send({ id: "state", type: "get_state" });
    send({ id: "commands", type: "get_commands" });
    send({ id: "model", type: "set_model", provider: "mock", modelId: "mock" });
    send({ id: "prompt", type: "prompt", message: "/skill:commit" });
    for await (const msg of jsonLines(proc.stdout)) {
      if (msg.type === "response") {
        responses.set(msg.id, msg);
        if (!msg.success) throw new Error(`RPC ${msg.command} failed: ${msg.error}`);
      } else if (msg.type === "extension_ui_request" && msg.method === "select") {
        if (!String(msg.title).includes("mcp__echo__echo")) throw new Error(`unexpected approval: ${msg.title}`);
        send({ type: "extension_ui_response", id: msg.id, value: "Allow" });
      } else if (msg.type === "agent_settled") {
        break;
      }
    }
  } finally {
    proc.kill();
  }
  const names = (responses.get("commands")?.data?.commands ?? []).map((c: any) => c.name);
  for (const skill of ["skill:code-review", "skill:commit", "skill:pr", "skill:security-review", "skill:simplify"]) {
    const count = names.filter((n: string) => n === skill).length;
    if (count !== 1) throw new Error(`expected one ${skill} command, saw ${count} in ${JSON.stringify(names)}`);
  }
  pass("built-in skills listed exactly once in get_commands");
  if (!responses.get("prompt")?.success) throw new Error("no successful response for /skill:commit");
  pass("/skill:commit expands and runs without error");
}

try {
  await withTimeout(rpcTurn(), "RPC turn");
  await withTimeout(codemodeTurn(), "codemode turn");
  await withTimeout(builtinSkills(), "built-in skills");
  await withTimeout(oauthStart(), "OAuth start");
  console.log(`\nsmoke test passed (${checks.length} checks)`);
} catch (error) {
  console.error(`\nsmoke test FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
