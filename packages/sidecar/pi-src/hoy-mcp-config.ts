// MCP config for Pi's built-in MCP extension (createMcpExtension's loadConfig).
// Pi's own loader is not exported and only reads <agentDir>/mcp.json plus
// <cwd>/.hoy/mcp.json; ours layers in the repo's shared .mcp.json and adapts
// entries to how Hoy runs MCP:
// - Exposure defaults to `deferred` (reached via tool_search). Pi defaults to
//   `codemode`, which Hoy does not load (its QuickJS worker is not in the
//   compiled sidecar), and Pi's mcp_servers prompt section would then tell the
//   model to call tools from codemode scripts that do not exist.
// - Legacy `disabled: true` (pre-Pi-MCP Hoy files) maps to `enabled: false`.
// - Project files are read only once the project is trusted, like Pi's.
// - ${VAR} in command, args, url, and cwd is filled from the sidecar env, as
//   Hoy's own MCP did. Pi itself only interpolates env and headers values, so
//   those are left for Pi (expanding them here too would eat $${VAR} escapes).
// Pi validates nothing here beyond what its runtime does on connect, so the
// shape checks below reject the entries Pi's loader would have rejected.

import type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];
const EXPOSURES = new Set(["codemode", "deferred", "direct", "hidden"]);

type Scope = "global" | "project";
type Env = Record<string, string | undefined>;

// ${VAR} -> env.VAR, missing -> "". $${VAR} is a literal ${VAR}. One
// left-to-right pass, so an expanded value is never re-expanded.
export function interpolateEnv(value: string, env: Env): string {
  return value.replace(/\$(\$?)\{(\w+)\}/g, (_m, esc, k) => (esc ? `\${${k}}` : env[k] ?? ""));
}

function interpolateFields(value: Record<string, unknown>, env: Env): void {
  for (const key of ["command", "url", "cwd"]) {
    if (typeof value[key] === "string") value[key] = interpolateEnv(value[key] as string, env);
  }
  if (Array.isArray(value.args)) {
    value.args = value.args.map((a) => (typeof a === "string" ? interpolateEnv(a, env) : a));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

// codemode (and its codemode-deferred alias) has no reachable tool in Hoy.
function adaptExposure(value: unknown): McpExposure | undefined {
  if (value === undefined || value === "codemode" || value === "codemode-deferred") return "deferred";
  return EXPOSURES.has(value as string) ? (value as McpExposure) : undefined;
}

// Returns the adapted config or an error string, mirroring Pi's
// validateMcpServerConfig for the fields Hoy's files actually use.
// `env: null` skips interpolation, for an override merged onto a global entry
// that was already expanded (re-expanding would undo $${VAR} escapes).
export function adaptServer(name: string, raw: unknown, env: Env | null = process.env): McpServerConfig | string {
  if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const { disabled, ...rest } = raw;
  const value: Record<string, unknown> = { ...rest };
  if (env) interpolateFields(value, env);
  if (disabled === true && value.enabled === undefined) value.enabled = false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return `server "${name}": enabled must be a boolean`;
  }
  const exposure = adaptExposure(value.exposure);
  if (!exposure) return `server "${name}": exposure must be one of codemode, deferred, direct, hidden`;
  value.exposure = exposure;
  if (value.toolExposure !== undefined) {
    if (!isRecord(value.toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
    const tools: Record<string, McpExposure> = {};
    for (const [tool, v] of Object.entries(value.toolExposure)) {
      const adapted = v === undefined ? undefined : adaptExposure(v);
      if (!adapted) return `server "${name}": toolExposure "${tool}" is not a valid exposure`;
      tools[tool] = adapted;
    }
    value.toolExposure = tools;
  }
  if (value.type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
  if (typeof value.url === "string") {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return `server "${name}": headers must map names to strings`;
    }
    return value as unknown as McpServerConfig;
  }
  if (typeof value.command === "string") {
    if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((a) => typeof a === "string"))) {
      return `server "${name}": args must be an array of strings`;
    }
    if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
    if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
    return value as unknown as McpServerConfig;
  }
  return `server "${name}" needs "command" or "url"`;
}

function readLayer(path: string, scope: Scope, servers: Map<string, McpServerEntry>, errors: string[], env: Env): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: expected an object with an "mcpServers" object`);
    return;
  }
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    // A project entry without command/url/type adjusts a global server of the
    // same name (Pi's override semantics), keeping its credentials.
    if (scope === "project" && isRecord(raw) && raw.command === undefined && raw.url === undefined && raw.type === undefined) {
      const base = servers.get(name);
      const extra = Object.keys(raw).filter((k) => !OVERRIDE_KEYS.includes(k) && k !== "disabled");
      if (!base) errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
      else if (extra.length > 0) errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
      else {
        const config = adaptServer(name, { ...base.config, ...raw }, null);
        if (typeof config === "string") errors.push(`${path}: ${config}`);
        else servers.set(name, { ...base, config, override: path });
      }
      continue;
    }
    const config = adaptServer(name, raw, env);
    if (typeof config === "string") {
      errors.push(`${path}: ${config}`);
      continue;
    }
    // Project files cannot route a /login credential to a server they pick.
    if (scope === "project" && "auth" in config && config.auth) {
      errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
      continue;
    }
    servers.set(name, { name, config, source: path, scope });
  }
}

// Low to high precedence: <agentDir>/mcp.json, then (trusted projects only) the
// shared <cwd>/.mcp.json and Hoy's <cwd>/.hoy/mcp.json, which the settings UI
// writes. `enabled: false` skips the whole load, for subagents without mcp.
export function loadHoyMcpConfig(opts: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  enabled?: boolean;
  env?: Env;
}): LoadedMcpConfig {
  const env = opts.env ?? process.env;
  if (opts.enabled === false) return { servers: [], errors: [], autoEnableCodemode: false };
  const servers = new Map<string, McpServerEntry>();
  const errors: string[] = [];
  readLayer(join(opts.agentDir, "mcp.json"), "global", servers, errors, env);
  const projectConfig = join(opts.cwd, ".hoy", "mcp.json");
  if (opts.projectTrusted) {
    readLayer(join(opts.cwd, ".mcp.json"), "project", servers, errors, env);
    readLayer(projectConfig, "project", servers, errors, env);
  }
  return {
    servers: [...servers.values()],
    autoEnableCodemode: false,
    errors,
    ...(opts.projectTrusted ? { projectConfig } : {}),
  };
}

// Pi's names for what Hoy calls the `mcp` tool. mcp__* lets direct-exposure
// servers through the allowlist; deferred ones are declared by tool_search.
export const MCP_TOOL_NAMES = [
  "tool_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "mcp__*",
];

export function expandToolNames(tools: string[]): string[] {
  return tools.flatMap((name) => (name === "mcp" ? MCP_TOOL_NAMES : [name]));
}
