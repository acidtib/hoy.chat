// HOY-232: MCP support as an in-process Pi extension. We register a single `mcp`
// proxy tool (search/describe/call) backed by the official
// @modelcontextprotocol/sdk, instead of registering every server's tools up
// front (~200 tokens vs 10k+ per server). Servers connect lazily and metadata
// is cached. Config is our own mcp.json (global + per-project), loaded
// and merged by the entry (loadMcpConfig) and handed here as a plain object so
// this module stays pure and testable.
//
// Security: starting a server is arbitrary subprocess execution (stdio) or
// network egress (http), so the first connect to a server and each distinct tool
// call require explicit consent unless autonomous mode pre-approves them. The
// proxy tool defeats the name-based permission gate, which only ever sees
// "mcp". Project-scoped servers additionally require project trust before any
// connect. See docs/plans/HOY-210-mcp-support-findings.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { accessSync, constants, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { PermissionState } from "./hoy-permissions";

export type McpScope = "global" | "project";

export interface McpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = (McpStdioServer | McpHttpServer) & {
  disabled?: boolean;
};

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerSpec>;
}

// A server after global+project merge, tagged with the scope it came from so we
// can enforce project trust on project-scoped servers.
export interface ResolvedServer {
  name: string;
  scope: McpScope;
  spec: McpServerSpec;
}

export interface McpConfig {
  servers: ResolvedServer[];
}

function isHttp(spec: McpServerSpec): spec is McpHttpServer & { disabled?: boolean } {
  return typeof (spec as McpHttpServer).url === "string";
}

// ${VAR} -> process.env.VAR, recursively over strings. Missing vars become "".
// Keeps secrets out of a committed mcp.json (the value is a reference, not the
// secret). $${VAR} escapes a literal ${VAR}. Single left-to-right pass so an
// escape can't be re-expanded and a value's own "${" text is never touched.
function interpolateEnv<T>(value: T, env: Record<string, string | undefined>): T {
  if (typeof value === "string") {
    return value.replace(/\$(\$?)\{(\w+)\}/g, (_m, esc, k) => (esc ? `\${${k}}` : env[k] ?? "")) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out as T;
  }
  return value;
}

// Merge scope-tagged config layers in precedence order (later layers win on a
// name collision, and the winning layer's scope is what sticks, so a project
// override of a global server becomes project-scoped and trust-gated). Disabled
// servers are dropped here.
export function mergeLayers(
  layers: Array<{ config: McpConfigFile; scope: McpScope }>,
  env: Record<string, string | undefined>,
): McpConfig {
  const byName = new Map<string, ResolvedServer>();
  for (const { config, scope } of layers) {
    for (const [name, spec] of Object.entries(config.mcpServers ?? {})) {
      if (spec?.disabled) continue;
      byName.set(name, { name, scope, spec: interpolateEnv(spec, env) });
    }
  }
  return { servers: [...byName.values()] };
}

// Two-layer convenience (global + one project file), kept for callers/tests.
export function mergeConfigs(
  global: McpConfigFile,
  project: McpConfigFile,
  env: Record<string, string | undefined>,
): McpConfig {
  return mergeLayers(
    [
      { config: global, scope: "global" },
      { config: project, scope: "project" },
    ],
    env,
  );
}

// Missing or malformed files yield an empty config; a bad mcp.json must never
// brick the sidecar (matches pi_config's read-side tolerance).
function readConfigFile(path: string): McpConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as McpConfigFile) : {};
  } catch {
    return {};
  }
}

// Resolve a relative command (e.g. "bunx") to an absolute path by searching
// PATH. Returns the command as-is if already absolute or contains a path
// separator (e.g. "./my-server"). On Windows, tries PATHEXT extensions
// (.exe/.cmd/.bat/.com) when the bare command is not found, so npm-installed
// CLI shims like bunx.cmd resolve correctly. Throws with a helpful message if
// the command can't be found.
export function resolveCommand(
  command: string,
  env: Record<string, string | undefined>,
): string {
  // Absolute paths (e.g. "/usr/bin/bunx") and relative paths with separators
  // (e.g. "./my-server", "subdir/server") are returned as-is.
  if (/^(\/|[a-zA-Z]:[\\\/])/.test(command) || command.includes("/") || command.includes("\\")) return command;

  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // PATHEXT is semicolon-delimited on Windows; on other platforms it is unset
  // so the inner loop is a no-op.
  const pathext = (env.PATHEXT ?? "").split(";").filter(Boolean);
  for (const dir of pathDirs) {
    const fullPath = join(dir, command);
    try {
      accessSync(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // not found bare; try each PATHEXT extension
    }
    for (const ext of pathext) {
      const withExt = ext.startsWith(".") ? fullPath + ext : fullPath + "." + ext;
      try {
        accessSync(withExt, constants.X_OK);
        return withExt;
      } catch {
        // not found with this extension, continue
      }
    }
  }

  throw new Error(
    `MCP server command "${command}" not found in PATH. ` +
      `Install it or add its directory to PATH. ` +
      `Searched: ${pathDirs.join(", ") || "(empty PATH)"}`,
  );
}

// Three sources, low to high precedence:
//   global      $HOY_CODING_AGENT_DIR/mcp.json  (Hoy's agent dir)
//   project     <cwd>/.mcp.json                 (the standard cross-tool file, so
//                                                a repo's existing MCP servers,
//                                                shared with Cursor/Claude Code,
//                                                just work)
//   project     <cwd>/.hoy/mcp.json             (Hoy's own, HOY-222; the file the
//                                                settings UI writes, wins)
// Both project files are project-scoped, so trust gating applies to servers a
// cloned repo declares. ${ENV} in values is interpolated from the sidecar env.
export function loadMcpConfig(agentDir: string, cwd: string, env: Record<string, string | undefined> = process.env): McpConfig {
  return mergeLayers(
    [
      { config: readConfigFile(join(agentDir, "mcp.json")), scope: "global" },
      { config: readConfigFile(join(cwd, ".mcp.json")), scope: "project" },
      { config: readConfigFile(join(cwd, ".hoy", "mcp.json")), scope: "project" },
    ],
    env,
  );
}

interface ManagedServer extends ResolvedServer {
  client?: Client;
  tools?: McpToolMeta[];
}

interface McpToolMeta {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const ALLOW = "Allow";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

const NUL = "\u0000";

export function requiresMcpConsent(state: PermissionState): boolean {
  return state.mode !== "autonomous";
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

const mcpParams = Type.Object({
  action: Type.Union(
    [Type.Literal("search"), Type.Literal("describe"), Type.Literal("call")],
    {
      description:
        "search: list available tools across configured MCP servers. describe: show one tool's input schema. call: invoke a tool (requires server + tool).",
    },
  ),
  server: Type.Optional(Type.String({ description: "MCP server name. Required for describe and call." })),
  tool: Type.Optional(Type.String({ description: "Tool name. Required for describe and call." })),
  args: Type.Optional(Type.Any({ description: "Arguments object for the tool call (see describe)." })),
});

export function createHoyMcp(config: McpConfig, permissionState: PermissionState) {
  const servers = new Map<string, ManagedServer>();
  for (const s of config.servers) servers.set(s.name, { ...s });

  const connectConsented = new Set<string>(); // server name
  const callConsented = new Set<string>(); // `${server}\0${tool}`

  async function connect(s: ManagedServer): Promise<Client> {
    const client = new Client({ name: "hoy", version: "0.0.0" }, { capabilities: {} });
    if (isHttp(s.spec)) {
      const transport = new StreamableHTTPClientTransport(new URL(s.spec.url), {
        requestInit: s.spec.headers ? { headers: s.spec.headers } : undefined,
      });
      await client.connect(transport);
    } else {
      const spec = s.spec as McpStdioServer;
      const env = { ...(process.env as Record<string, string>), ...(spec.env ?? {}) };
      const resolvedCommand = resolveCommand(spec.command, env);
      const transport = new StdioClientTransport({
        command: resolvedCommand,
        args: spec.args ?? [],
        env,
        cwd: spec.cwd,
      });
      await client.connect(transport);
    }
    return client;
  }

  async function ensureConnected(name: string, ctx: ExtensionContext): Promise<ManagedServer> {
    const s = servers.get(name);
    if (!s) throw new Error(`Unknown MCP server: "${name}". Use action:search to list servers.`);
    if (s.client) return s;

    if (s.scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error(
        `MCP server "${name}" is declared in this project's .hoy/mcp.json, which is not trusted. Trust the project to use it.`,
      );
    }

    if (requiresMcpConsent(permissionState) && !connectConsented.has(name)) {
      const what = isHttp(s.spec) ? `connect to ${s.spec.url}` : `run "${s.spec.command}"`;
      const choice = await ctx.ui.select(
        `Start MCP server "${name}"? Hoy will ${what} (${s.scope} scope).`,
        [ALLOW, DENY],
      );
      if (choice !== ALLOW) throw new Error(`User declined to start MCP server "${name}".`);
      connectConsented.add(name);
    }

    s.client = await connect(s);
    return s;
  }

  async function listTools(name: string, ctx: ExtensionContext): Promise<McpToolMeta[]> {
    const s = await ensureConnected(name, ctx);
    if (s.tools) return s.tools;
    const res = await s.client!.listTools();
    const tools: McpToolMeta[] = res.tools.map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    s.tools = tools;
    return tools;
  }

  async function requireCallConsent(server: string, tool: string, ctx: ExtensionContext): Promise<void> {
    if (!requiresMcpConsent(permissionState)) return;
    const key = `${server}${NUL}${tool}`;
    if (callConsented.has(key)) return;
    const choice = await ctx.ui.select(`Run MCP tool "${server}/${tool}"?`, [ALLOW, ALLOW_SESSION, DENY]);
    if (choice === ALLOW_SESSION) {
      callConsented.add(key);
      return;
    }
    if (choice === ALLOW) return;
    throw new Error(`User declined MCP tool "${server}/${tool}".`);
  }

  async function run(params: any, ctx: ExtensionContext) {
    switch (params.action) {
      case "search": {
        if (servers.size === 0) return textResult("No MCP servers are configured.");
        const lines: string[] = [];
        for (const name of servers.keys()) {
          try {
            for (const t of await listTools(name, ctx)) {
              lines.push(`${name}/${t.name}: ${t.description ?? ""}`.trim());
            }
          } catch (e) {
            lines.push(`${name}: (unavailable: ${String(e instanceof Error ? e.message : e)})`);
          }
        }
        return textResult(lines.length ? lines.join("\n") : "No MCP tools available.");
      }
      case "describe": {
        if (!params.server || !params.tool) throw new Error("describe requires server and tool.");
        const tools = await listTools(params.server, ctx);
        const t = tools.find((x) => x.name === params.tool);
        if (!t) throw new Error(`Unknown tool: ${params.server}/${params.tool}. Use action:search.`);
        return textResult(JSON.stringify(t, null, 2));
      }
      case "call": {
        if (!params.server || !params.tool) throw new Error("call requires server and tool.");
        await ensureConnected(params.server, ctx);
        await requireCallConsent(params.server, params.tool, ctx);
        const s = servers.get(params.server)!;
        const res: any = await s.client!.callTool({ name: params.tool, arguments: params.args ?? {} });
        const content = Array.isArray(res?.content)
          ? res.content.map((c: any) =>
              c?.type === "text" ? { type: "text" as const, text: c.text } : { type: "text" as const, text: JSON.stringify(c) },
            )
          : [{ type: "text" as const, text: JSON.stringify(res) }];
        return { content, details: res };
      }
      default:
        throw new Error(`Unknown mcp action: ${params.action}`);
    }
  }

  return function hoyMcp(pi: ExtensionAPI) {
    pi.registerTool({
      name: "mcp",
      label: "MCP",
      description:
        "Access tools exposed by configured MCP servers. action:search lists tools, action:describe shows a tool's input schema, action:call invokes a tool (server + tool required). Prefer search then describe before calling an unfamiliar tool.",
      promptSnippet:
        servers.size > 0
          ? "mcp (call tools from configured MCP servers; use action search/describe/call)"
          : undefined,
      parameters: mcpParams,
      execute: async (_id, params, _signal, _onUpdate, ctx) => run(params, ctx),
    });

    pi.on("session_shutdown", async () => {
      for (const s of servers.values()) {
        try {
          await s.client?.close();
        } catch {
          // best effort; the child dies with the sidecar regardless
        }
      }
    });
  };
}
